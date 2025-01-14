/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

/**
 * This module contains utilities and base classes for logic which is
 * common between the parent and child process, and in particular
 * between ExtensionParent.jsm and ExtensionChild.jsm.
 */

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

/* exported ExtensionCommon */

this.EXPORTED_SYMBOLS = ["ExtensionCommon"];

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "MessageChannel",
                                  "resource://gre/modules/MessageChannel.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PrivateBrowsingUtils",
                                  "resource://gre/modules/PrivateBrowsingUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Schemas",
                                  "resource://gre/modules/Schemas.jsm");

Cu.import("resource://gre/modules/ExtensionUtils.jsm");

var {
  DefaultMap,
  DefaultWeakMap,
  EventEmitter,
  ExtensionError,
  SpreadArgs,
  getConsole,
  getInnerWindowID,
  getUniqueId,
  runSafeSync,
  runSafeSyncWithoutClone,
  instanceOf,
} = ExtensionUtils;

XPCOMUtils.defineLazyGetter(this, "console", getConsole);

class BaseContext {
  constructor(envType, extension) {
    this.envType = envType;
    this.onClose = new Set();
    this.checkedLastError = false;
    this._lastError = null;
    this.contextId = getUniqueId();
    this.unloaded = false;
    this.extension = extension;
    this.jsonSandbox = null;
    this.active = true;
    this.incognito = null;
    this.messageManager = null;
    this.docShell = null;
    this.contentWindow = null;
    this.innerWindowID = 0;
  }

  setContentWindow(contentWindow) {
    let {document} = contentWindow;
    let docShell = contentWindow.QueryInterface(Ci.nsIInterfaceRequestor)
                                .getInterface(Ci.nsIDocShell);

    this.innerWindowID = getInnerWindowID(contentWindow);
    this.messageManager = docShell.QueryInterface(Ci.nsIInterfaceRequestor)
                                  .getInterface(Ci.nsIContentFrameMessageManager);

    if (this.incognito == null) {
      this.incognito = PrivateBrowsingUtils.isContentWindowPrivate(contentWindow);
    }

    MessageChannel.setupMessageManagers([this.messageManager]);

    let onPageShow = event => {
      if (!event || event.target === document) {
        this.docShell = docShell;
        this.contentWindow = contentWindow;
        this.active = true;
      }
    };
    let onPageHide = event => {
      if (!event || event.target === document) {
        // Put this off until the next tick.
        Promise.resolve().then(() => {
          this.docShell = null;
          this.contentWindow = null;
          this.active = false;
        });
      }
    };

    onPageShow();
    contentWindow.addEventListener("pagehide", onPageHide, true);
    contentWindow.addEventListener("pageshow", onPageShow, true);
    this.callOnClose({
      close: () => {
        onPageHide();
        if (this.active) {
          contentWindow.removeEventListener("pagehide", onPageHide, true);
          contentWindow.removeEventListener("pageshow", onPageShow, true);
        }
      },
    });
  }

  get cloneScope() {
    throw new Error("Not implemented");
  }

  get principal() {
    throw new Error("Not implemented");
  }

  runSafe(...args) {
    if (this.unloaded) {
      Cu.reportError("context.runSafe called after context unloaded");
    } else if (!this.active) {
      Cu.reportError("context.runSafe called while context is inactive");
    } else {
      return runSafeSync(this, ...args);
    }
  }

  runSafeWithoutClone(...args) {
    if (this.unloaded) {
      Cu.reportError("context.runSafeWithoutClone called after context unloaded");
    } else if (!this.active) {
      Cu.reportError("context.runSafeWithoutClone called while context is inactive");
    } else {
      return runSafeSyncWithoutClone(...args);
    }
  }

  checkLoadURL(url, options = {}) {
    let ssm = Services.scriptSecurityManager;

    let flags = ssm.STANDARD;
    if (!options.allowScript) {
      flags |= ssm.DISALLOW_SCRIPT;
    }
    if (!options.allowInheritsPrincipal) {
      flags |= ssm.DISALLOW_INHERIT_PRINCIPAL;
    }
    if (options.dontReportErrors) {
      flags |= ssm.DONT_REPORT_ERRORS;
    }

    try {
      ssm.checkLoadURIStrWithPrincipal(this.principal, url, flags);
    } catch (e) {
      return false;
    }
    return true;
  }

  /**
   * Safely call JSON.stringify() on an object that comes from an
   * extension.
   *
   * @param {array<any>} args Arguments for JSON.stringify()
   * @returns {string} The stringified representation of obj
   */
  jsonStringify(...args) {
    if (!this.jsonSandbox) {
      this.jsonSandbox = Cu.Sandbox(this.principal, {
        sameZoneAs: this.cloneScope,
        wantXrays: false,
      });
    }

    return Cu.waiveXrays(this.jsonSandbox.JSON).stringify(...args);
  }

  callOnClose(obj) {
    this.onClose.add(obj);
  }

  forgetOnClose(obj) {
    this.onClose.delete(obj);
  }

  /**
   * A wrapper around MessageChannel.sendMessage which adds the extension ID
   * to the recipient object, and ensures replies are not processed after the
   * context has been unloaded.
   *
   * @param {nsIMessageManager} target
   * @param {string} messageName
   * @param {object} data
   * @param {object} [options]
   * @param {object} [options.sender]
   * @param {object} [options.recipient]
   *
   * @returns {Promise}
   */
  sendMessage(target, messageName, data, options = {}) {
    options.recipient = Object.assign({extensionId: this.extension.id}, options.recipient);
    options.sender = options.sender || {};

    options.sender.extensionId = this.extension.id;
    options.sender.contextId = this.contextId;

    return MessageChannel.sendMessage(target, messageName, data, options);
  }

  get lastError() {
    this.checkedLastError = true;
    return this._lastError;
  }

  set lastError(val) {
    this.checkedLastError = false;
    this._lastError = val;
  }

  /**
   * Normalizes the given error object for use by the target scope. If
   * the target is an error object which belongs to that scope, it is
   * returned as-is. If it is an ordinary object with a `message`
   * property, it is converted into an error belonging to the target
   * scope. If it is an Error object which does *not* belong to the
   * clone scope, it is reported, and converted to an unexpected
   * exception error.
   *
   * @param {Error|object} error
   * @returns {Error}
   */
  normalizeError(error) {
    if (error instanceof this.cloneScope.Error) {
      return error;
    }
    let message, fileName;
    if (instanceOf(error, "Object") || error instanceof ExtensionError ||
        (typeof error == "object" && this.principal.subsumes(Cu.getObjectPrincipal(error)))) {
      message = error.message;
      fileName = error.fileName;
    } else {
      Cu.reportError(error);
    }
    message = message || "An unexpected error occurred";
    return new this.cloneScope.Error(message, fileName);
  }

  /**
   * Sets the value of `.lastError` to `error`, calls the given
   * callback, and reports an error if the value has not been checked
   * when the callback returns.
   *
   * @param {object} error An object with a `message` property. May
   *     optionally be an `Error` object belonging to the target scope.
   * @param {function} callback The callback to call.
   * @returns {*} The return value of callback.
   */
  withLastError(error, callback) {
    this.lastError = this.normalizeError(error);
    try {
      return callback();
    } finally {
      if (!this.checkedLastError) {
        Cu.reportError(`Unchecked lastError value: ${this.lastError}`);
      }
      this.lastError = null;
    }
  }

  /**
   * Wraps the given promise so it can be safely returned to extension
   * code in this context.
   *
   * If `callback` is provided, however, it is used as a completion
   * function for the promise, and no promise is returned. In this case,
   * the callback is called when the promise resolves or rejects. In the
   * latter case, `lastError` is set to the rejection value, and the
   * callback function must check `browser.runtime.lastError` or
   * `extension.runtime.lastError` in order to prevent it being reported
   * to the console.
   *
   * @param {Promise} promise The promise with which to wrap the
   *     callback. May resolve to a `SpreadArgs` instance, in which case
   *     each element will be used as a separate argument.
   *
   *     Unless the promise object belongs to the cloneScope global, its
   *     resolution value is cloned into cloneScope prior to calling the
   *     `callback` function or resolving the wrapped promise.
   *
   * @param {function} [callback] The callback function to wrap
   *
   * @returns {Promise|undefined} If callback is null, a promise object
   *     belonging to the target scope. Otherwise, undefined.
   */
  wrapPromise(promise, callback = null) {
    let runSafe = this.runSafe.bind(this);
    if (promise instanceof this.cloneScope.Promise) {
      runSafe = this.runSafeWithoutClone.bind(this);
    }

    if (callback) {
      promise.then(
        args => {
          if (this.unloaded) {
            dump(`Promise resolved after context unloaded\n`);
          } else if (!this.active) {
            dump(`Promise resolved while context is inactive\n`);
          } else if (args instanceof SpreadArgs) {
            runSafe(callback, ...args);
          } else {
            runSafe(callback, args);
          }
        },
        error => {
          this.withLastError(error, () => {
            if (this.unloaded) {
              dump(`Promise rejected after context unloaded\n`);
            } else if (!this.active) {
              dump(`Promise rejected while context is inactive\n`);
            } else {
              this.runSafeWithoutClone(callback);
            }
          });
        });
    } else {
      return new this.cloneScope.Promise((resolve, reject) => {
        promise.then(
          value => {
            if (this.unloaded) {
              dump(`Promise resolved after context unloaded\n`);
            } else if (!this.active) {
              dump(`Promise resolved while context is inactive\n`);
            } else if (value instanceof SpreadArgs) {
              runSafe(resolve, value.length == 1 ? value[0] : value);
            } else {
              runSafe(resolve, value);
            }
          },
          value => {
            if (this.unloaded) {
              dump(`Promise rejected after context unloaded: ${value && value.message}\n`);
            } else if (!this.active) {
              dump(`Promise rejected while context is inactive: ${value && value.message}\n`);
            } else {
              this.runSafeWithoutClone(reject, this.normalizeError(value));
            }
          });
      });
    }
  }

  unload() {
    this.unloaded = true;

    MessageChannel.abortResponses({
      extensionId: this.extension.id,
      contextId: this.contextId,
    });

    for (let obj of this.onClose) {
      obj.close();
    }
  }

  /**
   * A simple proxy for unload(), for use with callOnClose().
   */
  close() {
    this.unload();
  }
}

/**
 * An object that runs the implementation of a schema API. Instantiations of
 * this interfaces are used by Schemas.jsm.
 *
 * @interface
 */
class SchemaAPIInterface {
  /**
   * Calls this as a function that returns its return value.
   *
   * @abstract
   * @param {Array} args The parameters for the function.
   * @returns {*} The return value of the invoked function.
   */
  callFunction(args) {
    throw new Error("Not implemented");
  }

  /**
   * Calls this as a function and ignores its return value.
   *
   * @abstract
   * @param {Array} args The parameters for the function.
   */
  callFunctionNoReturn(args) {
    throw new Error("Not implemented");
  }

  /**
   * Calls this as a function that completes asynchronously.
   *
   * @abstract
   * @param {Array} args The parameters for the function.
   * @param {function(*)} [callback] The callback to be called when the function
   *     completes.
   * @returns {Promise|undefined} Must be void if `callback` is set, and a
   *     promise otherwise. The promise is resolved when the function completes.
   */
  callAsyncFunction(args, callback) {
    throw new Error("Not implemented");
  }

  /**
   * Retrieves the value of this as a property.
   *
   * @abstract
   * @returns {*} The value of the property.
   */
  getProperty() {
    throw new Error("Not implemented");
  }

  /**
   * Assigns the value to this as property.
   *
   * @abstract
   * @param {string} value The new value of the property.
   */
  setProperty(value) {
    throw new Error("Not implemented");
  }

  /**
   * Registers a `listener` to this as an event.
   *
   * @abstract
   * @param {function} listener The callback to be called when the event fires.
   * @param {Array} args Extra parameters for EventManager.addListener.
   * @see EventManager.addListener
   */
  addListener(listener, args) {
    throw new Error("Not implemented");
  }

  /**
   * Checks whether `listener` is listening to this as an event.
   *
   * @abstract
   * @param {function} listener The event listener.
   * @returns {boolean} Whether `listener` is registered with this as an event.
   * @see EventManager.hasListener
   */
  hasListener(listener) {
    throw new Error("Not implemented");
  }

  /**
   * Unregisters `listener` from this as an event.
   *
   * @abstract
   * @param {function} listener The event listener.
   * @see EventManager.removeListener
   */
  removeListener(listener) {
    throw new Error("Not implemented");
  }

  /**
   * Revokes the implementation object, and prevents any further method
   * calls from having external effects.
   *
   * @abstract
   */
  revoke() {
    throw new Error("Not implemented");
  }
}

/**
 * An object that runs a locally implemented API.
 */
class LocalAPIImplementation extends SchemaAPIInterface {
  /**
   * Constructs an implementation of the `name` method or property of `pathObj`.
   *
   * @param {object} pathObj The object containing the member with name `name`.
   * @param {string} name The name of the implemented member.
   * @param {BaseContext} context The context in which the schema is injected.
   */
  constructor(pathObj, name, context) {
    super();
    this.pathObj = pathObj;
    this.name = name;
    this.context = context;
  }

  revoke() {
    if (this.pathObj[this.name][Schemas.REVOKE]) {
      this.pathObj[this.name][Schemas.REVOKE]();
    }

    this.pathObj = null;
    this.name = null;
    this.context = null;
  }

  callFunction(args) {
    return this.pathObj[this.name](...args);
  }

  callFunctionNoReturn(args) {
    this.pathObj[this.name](...args);
  }

  callAsyncFunction(args, callback) {
    let promise;
    try {
      promise = this.pathObj[this.name](...args) || Promise.resolve();
    } catch (e) {
      promise = Promise.reject(e);
    }
    return this.context.wrapPromise(promise, callback);
  }

  getProperty() {
    return this.pathObj[this.name];
  }

  setProperty(value) {
    this.pathObj[this.name] = value;
  }

  addListener(listener, args) {
    try {
      this.pathObj[this.name].addListener.call(null, listener, ...args);
    } catch (e) {
      throw this.context.normalizeError(e);
    }
  }

  hasListener(listener) {
    return this.pathObj[this.name].hasListener.call(null, listener);
  }

  removeListener(listener) {
    this.pathObj[this.name].removeListener.call(null, listener);
  }
}

// Recursively copy properties from source to dest.
function deepCopy(dest, source) {
  for (let prop in source) {
    let desc = Object.getOwnPropertyDescriptor(source, prop);
    if (typeof(desc.value) == "object") {
      if (!(prop in dest)) {
        dest[prop] = {};
      }
      deepCopy(dest[prop], source[prop]);
    } else {
      Object.defineProperty(dest, prop, desc);
    }
  }
}

/**
 * Manages loading and accessing a set of APIs for a specific extension
 * context.
 *
 * @param {BaseContext} context
 *        The context to manage APIs for.
 * @param {SchemaAPIManager} apiManager
 *        The API manager holding the APIs to manage.
 * @param {object} root
 *        The root object into which APIs will be injected.
 */
class CanOfAPIs {
  constructor(context, apiManager, root) {
    this.context = context;
    this.scopeName = context.envType;
    this.apiManager = apiManager;
    this.root = root;

    this.apiPaths = new Map();

    this.apis = new Map();
  }

  /**
   * Synchronously loads and initializes an ExtensionAPI instance.
   *
   * @param {string} name
   *        The name of the API to load.
   */
  loadAPI(name) {
    if (this.apis.has(name)) {
      return;
    }

    let {extension} = this.context;

    let api = this.apiManager.getAPI(name, extension, this.scopeName);
    if (!api) {
      return;
    }

    this.apis.set(name, api);

    deepCopy(this.root, api.getAPI(this.context));
  }

  /**
   * Asynchronously loads and initializes an ExtensionAPI instance.
   *
   * @param {string} name
   *        The name of the API to load.
   */
  async asyncLoadAPI(name) {
    if (this.apis.has(name)) {
      return;
    }

    let {extension} = this.context;
    if (!Schemas.checkPermissions(name, extension)) {
      return;
    }

    let api = await this.apiManager.asyncGetAPI(name, extension, this.scopeName);
    // Check again, because async;
    if (this.apis.has(name)) {
      return;
    }

    this.apis.set(name, api);

    deepCopy(this.root, api.getAPI(this.context));
  }

  /**
   * Finds the API at the given path from the root object, and
   * synchronously loads the API that implements it if it has not
   * already been loaded.
   *
   * @param {string} path
   *        The "."-separated path to find.
   * @returns {*}
   */
  findAPIPath(path) {
    if (this.apiPaths.has(path)) {
      return this.apiPaths.get(path);
    }

    let obj = this.root;
    let modules = this.apiManager.modulePaths;

    for (let key of path.split(".")) {
      if (!obj) {
        return;
      }
      modules = modules.get(key);

      for (let name of modules.modules) {
        if (!this.apis.has(name)) {
          this.loadAPI(name);
        }
      }

      obj = obj[key];
    }

    this.apiPaths.set(path, obj);
    return obj;
  }

  /**
   * Finds the API at the given path from the root object, and
   * asynchronously loads the API that implements it if it has not
   * already been loaded.
   *
   * @param {string} path
   *        The "."-separated path to find.
   * @returns {Promise<*>}
   */
  async asyncFindAPIPath(path) {
    if (this.apiPaths.has(path)) {
      return this.apiPaths.get(path);
    }

    let obj = this.root;
    let modules = this.apiManager.modulePaths;

    for (let key of path.split(".")) {
      if (!obj) {
        return;
      }
      modules = modules.get(key);

      for (let name of modules.modules) {
        if (!this.apis.has(name)) {
          await this.asyncLoadAPI(name);
        }
      }

      if (typeof obj[key] === "function") {
        obj = obj[key].bind(obj);
      } else {
        obj = obj[key];
      }
    }

    this.apiPaths.set(path, obj);
    return obj;
  }
}

class DeepMap extends DefaultMap {
  constructor() {
    super(() => new DeepMap());

    this.modules = new Set();
  }

  getPath(path) {
    return path.reduce((map, key) => map.get(key), this);
  }
}

/**
 * @class APIModule
 * @abstract
 *
 * @property {string} url
 *       The URL of the script which contains the module's
 *       implementation. This script must define a global property
 *       matching the modules name, which must be a class constructor
 *       which inherits from {@link ExtensionAPI}.
 *
 * @property {string} schema
 *       The URL of the JSON schema which describes the module's API.
 *
 * @property {Array<string>} scopes
 *       The list of scope names into which the API may be loaded.
 *
 * @property {Array<string>} manifest
 *       The list of top-level manifest properties which will trigger
 *       the module to be loaded, and its `onManifestEntry` method to be
 *       called.
 *
 * @property {Array<string>} events
 *       The list events which will trigger the module to be loaded, and
 *       its appropriate event handler method to be called. Currently
 *       only accepts "startup".
 *
 * @property {Array<Array<string>>} paths
 *       A list of paths from the root API object which, when accessed,
 *       will cause the API module to be instantiated and injected.
 */

/**
 * This object loads the ext-*.js scripts that define the extension API.
 *
 * This class instance is shared with the scripts that it loads, so that the
 * ext-*.js scripts and the instantiator can communicate with each other.
 */
class SchemaAPIManager extends EventEmitter {
  /**
   * @param {string} processType
   *     "main" - The main, one and only chrome browser process.
   *     "addon" - An addon process.
   *     "content" - A content process.
   *     "devtools" - A devtools process.
   *     "proxy" - A proxy script process.
   */
  constructor(processType) {
    super();
    this.processType = processType;
    this.global = this._createExtGlobal();

    this.modules = new Map();
    this.modulePaths = new DeepMap();
    this.manifestKeys = new Map();
    this.eventModules = new DefaultMap(() => new Set());

    this.schemaURLs = new Set();

    this.apis = new DefaultWeakMap(() => new Map());

    this._scriptScopes = [];
  }

  /**
   * Registers a set of ExtensionAPI modules to be lazily loaded and
   * managed by this manager.
   *
   * @param {object} obj
   *        An object containing property for eacy API module to be
   *        registered. Each value should be an object implementing the
   *        APIModule interface.
   */
  registerModules(obj) {
    for (let [name, details] of Object.entries(obj)) {
      details.namespaceName = name;

      if (this.modules.has(name)) {
        throw new Error(`Module '${name}' already registered`);
      }
      this.modules.set(name, details);

      if (details.schema) {
        this.schemaURLs.add(details.schema);
      }

      for (let event of details.events || []) {
        this.eventModules.get(event).add(name);
      }

      for (let key of details.manifest || []) {
        if (this.manifestKeys.has(key)) {
          throw new Error(`Manifest key '${key}' already registered by '${this.manifestKeys.get(key)}'`);
        }

        this.manifestKeys.set(key, name);
      }

      for (let path of details.paths || []) {
        this.modulePaths.getPath(path).modules.add(name);
      }
    }
  }

  /**
   * Emits an `onManifestEntry` event for the top-level manifest entry
   * on all relevant {@link ExtensionAPI} instances for the given
   * extension.
   *
   * The API modules will be synchronously loaded if they have not been
   * loaded already.
   *
   * @param {Extension} extension
   *        The extension for which to emit the events.
   * @param {string} entry
   *        The name of the top-level manifest entry.
   *
   * @returns {*}
   */
  emitManifestEntry(extension, entry) {
    let apiName = this.manifestKeys.get(entry);
    if (apiName) {
      let api = this.getAPI(apiName, extension);
      return api.onManifestEntry(entry);
    }
  }
  /**
   * Emits an `onManifestEntry` event for the top-level manifest entry
   * on all relevant {@link ExtensionAPI} instances for the given
   * extension.
   *
   * The API modules will be asynchronously loaded if they have not been
   * loaded already.
   *
   * @param {Extension} extension
   *        The extension for which to emit the events.
   * @param {string} entry
   *        The name of the top-level manifest entry.
   *
   * @returns {Promise<*>}
   */
  async asyncEmitManifestEntry(extension, entry) {
    let apiName = this.manifestKeys.get(entry);
    if (apiName) {
      let api = await this.asyncGetAPI(apiName, extension);
      return api.onManifestEntry(entry);
    }
  }

  /**
   * Returns the {@link ExtensionAPI} instance for the given API module,
   * for the given extension, in the given scope, synchronously loading
   * and instantiating it if necessary.
   *
   * @param {string} name
   *        The name of the API module to load.
   * @param {Extension} extension
   *        The extension for which to load the API.
   * @param {string} [scope = null]
   *        The scope type for which to retrieve the API, or null if not
   *        being retrieved for a particular scope.
   *
   * @returns {ExtensionAPI?}
   */
  getAPI(name, extension, scope = null) {
    if (!this._checkGetAPI(name, extension, scope)) {
      return;
    }

    let apis = this.apis.get(extension);
    if (apis.has(name)) {
      return apis.get(name);
    }

    let module = this.loadModule(name);

    let api = new module(extension);
    apis.set(name, api);
    return api;
  }
  /**
   * Returns the {@link ExtensionAPI} instance for the given API module,
   * for the given extension, in the given scope, asynchronously loading
   * and instantiating it if necessary.
   *
   * @param {string} name
   *        The name of the API module to load.
   * @param {Extension} extension
   *        The extension for which to load the API.
   * @param {string} [scope = null]
   *        The scope type for which to retrieve the API, or null if not
   *        being retrieved for a particular scope.
   *
   * @returns {Promise<ExtensionAPI>?}
   */
  async asyncGetAPI(name, extension, scope = null) {
    if (!this._checkGetAPI(name, extension, scope)) {
      return;
    }

    let apis = this.apis.get(extension);
    if (apis.has(name)) {
      return apis.get(name);
    }

    let module = await this.asyncLoadModule(name);

    // Check again, because async.
    if (apis.has(name)) {
      return apis.get(name);
    }

    let api = new module(extension);
    apis.set(name, api);
    return api;
  }

  /**
   * Synchronously loads an API module, if not already loaded, and
   * returns its ExtensionAPI constructor.
   *
   * @param {string} name
   *        The name of the module to load.
   *
   * @returns {class}
   */
  loadModule(name) {
    let module = this.modules.get(name);
    if (module.loaded) {
      return this.global[name];
    }

    this._checkLoadModule(module, name);

    Services.scriptloader.loadSubScript(module.url, this.global, "UTF-8");

    module.loaded = true;

    return this._initModule(module, this.global[name]);
  }
  /**
   * aSynchronously loads an API module, if not already loaded, and
   * returns its ExtensionAPI constructor.
   *
   * @param {string} name
   *        The name of the module to load.
   *
   * @returns {Promise<class>}
   */
  asyncLoadModule(name) {
    let module = this.modules.get(name);
    if (module.loaded) {
      return Promise.resolve(this.global[name]);
    }
    if (module.asyncLoaded) {
      return module.asyncLoaded;
    }

    this._checkLoadModule(module, name);

    module.asyncLoaded = ChromeUtils.compileScript(module.url).then(script => {
      script.executeInGlobal(this.global);

      module.loaded = true;

      return this._initModule(module, this.global[name]);
    });

    return module.asyncLoaded;
  }

  /**
   * Checks whether the given API module may be loaded for the given
   * extension, in the given scope.
   *
   * @param {string} name
   *        The name of the API module to check.
   * @param {Extension} extension
   *        The extension for which to check the API.
   * @param {string} [scope = null]
   *        The scope type for which to check the API, or null if not
   *        being checked for a particular scope.
   *
   * @returns {boolean}
   *        Whether the module may be loaded.
   */
  _checkGetAPI(name, extension, scope = null) {
    let module = this.modules.get(name);

    if (!scope) {
      return true;
    }

    if (!module.scopes.includes(scope)) {
      return false;
    }

    if (!Schemas.checkPermissions(module.namespaceName, extension)) {
      return false;
    }

    return true;
  }

  _initModule(info, cls) {
    cls.namespaceName = cls.namespaceName;
    cls.scopes = new Set(info.scopes);

    return cls;
  }

  _checkLoadModule(module, name) {
    if (!module) {
      throw new Error(`Module '${name}' does not exist`);
    }
    if (module.asyncLoaded) {
      throw new Error(`Module '${name}' currently being lazily loaded`);
    }
    if (this.global[name]) {
      throw new Error(`Module '${name}' conflicts with existing global property`);
    }
  }


  /**
   * Create a global object that is used as the shared global for all ext-*.js
   * scripts that are loaded via `loadScript`.
   *
   * @returns {object} A sandbox that is used as the global by `loadScript`.
   */
  _createExtGlobal() {
    let global = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), {
      wantXrays: false,
      sandboxName: `Namespace of ext-*.js scripts for ${this.processType}`,
    });

    Object.assign(global, {global, Cc, Ci, Cu, Cr, XPCOMUtils, extensions: this});

    Cu.import("resource://gre/modules/AppConstants.jsm", global);
    Cu.import("resource://gre/modules/ExtensionAPI.jsm", global);

    XPCOMUtils.defineLazyGetter(global, "console", getConsole);

    XPCOMUtils.defineLazyModuleGetter(global, "ExtensionUtils",
                                      "resource://gre/modules/ExtensionUtils.jsm");
    XPCOMUtils.defineLazyModuleGetter(global, "XPCOMUtils",
                                      "resource://gre/modules/XPCOMUtils.jsm");
    XPCOMUtils.defineLazyModuleGetter(global, "require",
                                      "resource://devtools/shared/Loader.jsm");

    return global;
  }

  /**
   * Load an ext-*.js script. The script runs in its own scope, if it wishes to
   * share state with another script it can assign to the `global` variable. If
   * it wishes to communicate with this API manager, use `extensions`.
   *
   * @param {string} scriptUrl The URL of the ext-*.js script.
   */
  loadScript(scriptUrl) {
    // Create the object in the context of the sandbox so that the script runs
    // in the sandbox's context instead of here.
    let scope = Cu.createObjectIn(this.global);

    Services.scriptloader.loadSubScript(scriptUrl, scope, "UTF-8");

    // Save the scope to avoid it being garbage collected.
    this._scriptScopes.push(scope);
  }

  /**
   * Mash together all the APIs from `apis` into `obj`.
   *
   * @param {BaseContext} context The context for which the API bindings are
   *     generated.
   * @param {Array} apis A list of objects, see `registerSchemaAPI`.
   * @param {object} obj The destination of the API.
   */
  static generateAPIs(context, apis, obj) {
    function hasPermission(perm) {
      return context.extension.hasPermission(perm, true);
    }
    for (let api of apis) {
      if (Schemas.checkPermissions(api.namespace, {hasPermission})) {
        api = api.getAPI(context);
        deepCopy(obj, api);
      }
    }
  }
}

const ExtensionCommon = {
  BaseContext,
  CanOfAPIs,
  LocalAPIImplementation,
  SchemaAPIInterface,
  SchemaAPIManager,
};
