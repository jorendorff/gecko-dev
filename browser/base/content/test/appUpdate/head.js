Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

const IS_MACOSX = ("nsILocalFileMac" in Ci);
const IS_WIN = ("@mozilla.org/windows-registry-key;1" in Cc);

const BIN_SUFFIX = (IS_WIN ? ".exe" : "");
const FILE_UPDATER_BIN = "updater" + (IS_MACOSX ? ".app" : BIN_SUFFIX);
const FILE_UPDATER_BIN_BAK = FILE_UPDATER_BIN + ".bak";

let gRembemberedPrefs = [];

const DATA_URI_SPEC =  "chrome://mochitests/content/browser/browser/base/content/test/appUpdate/";

var DEBUG_AUS_TEST = true;
var gUseTestUpdater = false;

const LOG_FUNCTION = info;

/* import-globals-from testConstants.js */
Services.scriptloader.loadSubScript(DATA_URI_SPEC + "testConstants.js", this);
/* import-globals-from ../../../../../toolkit/mozapps/update/tests/data/shared.js */
Services.scriptloader.loadSubScript(DATA_URI_SPEC + "shared.js", this);

var gURLData = URL_HOST + "/" + REL_PATH_DATA;
const URL_MANUAL_UPDATE = gURLData + "downloadPage.html";

const NOTIFICATIONS = [
  "update-available",
  "update-manual",
  "update-restart"
];

/**
 * Delay for a very short period. Useful for moving the code after this
 * to the back of the event loop.
 *
 * @return A promise which will resolve after a very short period.
 */
function delay() {
  return new Promise(resolve => executeSoon(resolve));
}

/**
 * Gets the update version info for the update url parameters to send to
 * update.sjs.
 *
 * @param  aAppVersion (optional)
 *         The application version for the update snippet. If not specified the
 *         current application version will be used.
 * @return The url parameters for the application and platform version to send
 *         to update.sjs.
 */
function getVersionParams(aAppVersion) {
  let appInfo = Services.appinfo;
  return "&appVersion=" + (aAppVersion ? aAppVersion : appInfo.version);
}

/**
 * Clean up updates list and the updates directory.
 */
function cleanUpUpdates() {
  gUpdateManager.activeUpdate = null;
  gUpdateManager.saveUpdates();

  removeUpdateDirsAndFiles();
}

/**
 * Runs a typical update test. Will set various common prefs for using the
 * updater doorhanger, runs the provided list of steps, and makes sure
 * everything is cleaned up afterwards.
 *
 * @param  updateParams
 *         URL-encoded params which will be sent to update.sjs.
 * @param  checkAttempts
 *         How many times to check for updates. Useful for testing the UI
 *         for check failures.
 * @param  steps
 *         A list of test steps to perform, specifying expected doorhangers
 *         and additional validation/cleanup callbacks.
 * @return A promise which will resolve once all of the steps have been run
 *         and cleanup has been performed.
 */
function runUpdateTest(updateParams, checkAttempts, steps) {
  return Task.spawn(function*() {
    registerCleanupFunction(() => {
      gMenuButtonUpdateBadge.uninit();
      gMenuButtonUpdateBadge.init();
      cleanUpUpdates();
    });
    yield SpecialPowers.pushPrefEnv({
      set: [
        [PREF_APP_UPDATE_DOWNLOADPROMPTATTEMPTS, 0],
        [PREF_APP_UPDATE_ENABLED, true],
        [PREF_APP_UPDATE_IDLETIME, 0],
        [PREF_APP_UPDATE_URL_MANUAL, URL_MANUAL_UPDATE],
        [PREF_APP_UPDATE_LOG, DEBUG_AUS_TEST],
      ]});

    yield setupTestUpdater();

    let url = URL_HTTP_UPDATE_SJS +
              "?" + updateParams +
              getVersionParams();

    setUpdateURL(url);

    executeSoon(() => {
      Task.spawn(function*() {
        gAUS.checkForBackgroundUpdates();
        for (var i = 0; i < checkAttempts - 1; i++) {
          yield waitForEvent("update-error", "check-attempt-failed");
          gAUS.checkForBackgroundUpdates();
        }
      });
    });

    for (let step of steps) {
      yield processStep(step);
    }

    yield finishTestRestoreUpdaterBackup();
  });
}

/**
 * Runs a test which processes an update. Similar to runUpdateTest.
 *
 * @param  updates
 *         A list of updates to process.
 * @param  steps
 *         A list of test steps to perform, specifying expected doorhangers
 *         and additional validation/cleanup callbacks.
 * @return A promise which will resolve once all of the steps have been run
 *         and cleanup has been performed.
 */
function runUpdateProcessingTest(updates, steps) {
  return Task.spawn(function*() {
    registerCleanupFunction(() => {
      gMenuButtonUpdateBadge.reset();
      cleanUpUpdates();
    });

    SpecialPowers.pushPrefEnv({
      set: [
        [PREF_APP_UPDATE_DOWNLOADPROMPTATTEMPTS, 0],
        [PREF_APP_UPDATE_ENABLED, true],
        [PREF_APP_UPDATE_IDLETIME, 0],
        [PREF_APP_UPDATE_URL_MANUAL, URL_MANUAL_UPDATE],
        [PREF_APP_UPDATE_LOG, DEBUG_AUS_TEST],
      ]});

    yield setupTestUpdater();

    writeUpdatesToXMLFile(getLocalUpdatesXMLString(updates), true);

    writeUpdatesToXMLFile(getLocalUpdatesXMLString(""), false);
    writeStatusFile(STATE_FAILED_CRC_ERROR);
    reloadUpdateManagerData();

    testPostUpdateProcessing();

    for (let step of steps) {
      yield processStep(step);
    }

    yield finishTestRestoreUpdaterBackup();
  });
}

function processStep({notificationId, button, beforeClick, cleanup}) {
  return Task.spawn(function*() {

    yield BrowserTestUtils.waitForEvent(PanelUI.notificationPanel, "popupshown");
    const shownNotification = PanelUI.activeNotification.id;

    is(shownNotification, notificationId, "The right notification showed up.");
    if (shownNotification != notificationId) {
      if (cleanup) {
        yield cleanup();
      }
      return;
    }

    let notification = document.getElementById(`PanelUI-${notificationId}-notification`);
    is(notification.hidden, false, `${notificationId} notification is showing`);
    if (beforeClick) {
      yield Task.spawn(beforeClick);
    }

    let buttonEl = document.getAnonymousElementByAttribute(notification, "anonid", button);

    buttonEl.click();

    if (cleanup) {
      yield cleanup();
    }
  });
}

/**
 * Waits for the specified topic and (optionally) status.
 * @param  topic
 *         String representing the topic to wait for.
 * @param  status
 *         Optional String representing the status on said topic to wait for.
 * @return A promise which will resolve the first time an event occurs on the
 *         specified topic, and (optionally) with the specified status.
 */
function waitForEvent(topic, status = null) {
  return new Promise(resolve => Services.obs.addObserver({
    observe(subject, innerTopic, innerStatus) {
      if (!status || status == innerStatus) {
        Services.obs.removeObserver(this, topic);
        resolve(innerStatus);
      }
    }
  }, topic, false))
}

/**
 * Ensures that the "What's new" link with the provided ID is displayed and
 * matches the url parameter provided. If no URL is provided, it will instead
 * ensure that the link matches the default link URL.
 *
 * @param  id
 *         The ID of the "What's new" link element.
 * @param  url (optional)
 *         The URL to check against. If none is provided, a default will be used.
 */
function checkWhatsNewLink(id, url) {
  let whatsNewLink = document.getElementById(id);
  is(whatsNewLink.href,
     url || URL_HTTP_UPDATE_SJS + "?uiURL=DETAILS",
     "What's new link points to the test_details URL");
  is(whatsNewLink.hidden, false, "What's new link is not hidden.");
}

/**
 * For tests that use the test updater restores the backed up real updater if
 * it exists and tries again on failure since Windows debug builds at times
 * leave the file in use. After success moveRealUpdater is called to continue
 * the setup of the test updater. For tests that don't use the test updater
 * runTest will be called.
 */
function setupTestUpdater() {
  return Task.spawn(function*() {
    if (gUseTestUpdater) {
      try {
        restoreUpdaterBackup();
      } catch (e) {
        logTestInfo("Attempt to restore the backed up updater failed... " +
                    "will try again, Exception: " + e);
        yield delay();
        yield setupTestUpdater();
        return;
      }
      yield moveRealUpdater();
    }
  });
}

/**
 * Backs up the real updater and tries again on failure since Windows debug
 * builds at times leave the file in use. After success it will call
 * copyTestUpdater to continue the setup of the test updater.
 */
function moveRealUpdater() {
  return Task.spawn(function*() {
    try {
      // Move away the real updater
      let baseAppDir = getAppBaseDir();
      let updater = baseAppDir.clone();
      updater.append(FILE_UPDATER_BIN);
      updater.moveTo(baseAppDir, FILE_UPDATER_BIN_BAK);
    } catch (e) {
      logTestInfo("Attempt to move the real updater out of the way failed... " +
                  "will try again, Exception: " + e);
      yield delay();
      yield moveRealUpdater();
      return;
    }

    yield copyTestUpdater();
  });
}

/**
 * Copies the test updater so it can be used by tests and tries again on failure
 * since Windows debug builds at times leave the file in use. After success it
 * will call runTest to continue the test.
 */
function copyTestUpdater() {
  return Task.spawn(function*() {
    try {
      // Copy the test updater
      let baseAppDir = getAppBaseDir();
      let testUpdaterDir = Services.dirsvc.get("CurWorkD", Ci.nsILocalFile);
      let relPath = REL_PATH_DATA;
      let pathParts = relPath.split("/");
      for (let i = 0; i < pathParts.length; ++i) {
        testUpdaterDir.append(pathParts[i]);
      }

      let testUpdater = testUpdaterDir.clone();
      testUpdater.append(FILE_UPDATER_BIN);
      testUpdater.copyToFollowingLinks(baseAppDir, FILE_UPDATER_BIN);
    } catch (e) {
      logTestInfo("Attempt to copy the test updater failed... " +
                  "will try again, Exception: " + e);
      yield delay();
      yield copyTestUpdater();
    }
  });
}

/**
 * Restores the updater that was backed up. This is called in setupTestUpdater
 * before the backup of the real updater is done in case the previous test
 * failed to restore the updater, in finishTestDefaultWaitForWindowClosed when
 * the test has finished, and in test_9999_cleanup.xul after all tests have
 * finished.
 */
function restoreUpdaterBackup() {
  let baseAppDir = getAppBaseDir();
  let updater = baseAppDir.clone();
  let updaterBackup = baseAppDir.clone();
  updater.append(FILE_UPDATER_BIN);
  updaterBackup.append(FILE_UPDATER_BIN_BAK);
  if (updaterBackup.exists()) {
    if (updater.exists()) {
      updater.remove(true);
    }
    updaterBackup.moveTo(baseAppDir, FILE_UPDATER_BIN);
  }
}

/**
 * When a test finishes this will repeatedly attempt to restore the real updater
 * for tests that use the test updater and then call
 * finishTestDefaultWaitForWindowClosed after the restore is successful.
 */
function finishTestRestoreUpdaterBackup() {
  return Task.spawn(function*() {
    if (gUseTestUpdater) {
      try {
        // Windows debug builds keep the updater file in use for a short period of
        // time after the updater process exits.
        restoreUpdaterBackup();
      } catch (e) {
        logTestInfo("Attempt to restore the backed up updater failed... " +
                    "will try again, Exception: " + e);

        yield delay();
        yield finishTestRestoreUpdaterBackup();
      }
    }
  });
}
