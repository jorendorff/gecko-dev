/*
 * Copyright (c) 2013 Google Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

"use strict";

const { HEADERS } = require("../constants");
const HEADER_FILTERS = HEADERS
  .filter(h => h.canFilter)
  .map(h => h.filterKey || h.name);

const FILTER_FLAGS = [
  ...HEADER_FILTERS,
  "scheme",
  "mime-type",
  "larger-than",
  "is",
];

/*
  The function `parseFilters` is from:
  https://github.com/ChromeDevTools/devtools-frontend/

  front_end/network/FilterSuggestionBuilder.js#L138-L163
  Commit f340aefd7ec9b702de9366a812288cfb12111fce
*/

function parseFilters(query) {
  let flags = [];
  let text = [];
  let parts = query.split(/\s+/);

  for (let part of parts) {
    if (!part) {
      continue;
    }
    let colonIndex = part.indexOf(":");
    if (colonIndex === -1) {
      text.push(part);
      continue;
    }
    let key = part.substring(0, colonIndex);
    let negative = key.startsWith("-");
    if (negative) {
      key = key.substring(1);
    }
    if (!FILTER_FLAGS.includes(key)) {
      text.push(part);
      continue;
    }
    let value = part.substring(colonIndex + 1);
    value = processFlagFilter(key, value);
    flags.push({
      type: key,
      value,
      negative,
    });
  }

  return { text, flags };
}

function processFlagFilter(type, value) {
  switch (type) {
    case "size":
    case "transferred":
    case "larger-than":
      let multiplier = 1;
      if (value.endsWith("k")) {
        multiplier = 1024;
        value = value.substring(0, value.length - 1);
      } else if (value.endsWith("m")) {
        multiplier = 1024 * 1024;
        value = value.substring(0, value.length - 1);
      }
      let quantity = Number(value);
      if (isNaN(quantity)) {
        return null;
      }
      return quantity * multiplier;
    default:
      return value.toLowerCase();
  }
}

function getSizeOrder(size) {
  return Math.round(Math.log10(size));
}

function isFlagFilterMatch(item, { type, value, negative }) {
  let match = true;
  switch (type) {
    case "status-code":
      match = item.status === value;
      break;
    case "method":
      match = item.method.toLowerCase() === value;
      break;
    case "domain":
      match = item.urlDetails.host.toLowerCase().includes(value);
      break;
    case "remote-ip":
      match = `${item.remoteAddress}:${item.remotePort}`.toLowerCase().includes(value);
      break;
    case "cause":
      let causeType = item.cause.type;
      match = typeof causeType === "string" ?
                causeType.toLowerCase().includes(value) : false;
      break;
    case "transferred":
      if (item.fromCache) {
        match = false;
      } else {
        match = getSizeOrder(value) === getSizeOrder(item.transferredSize);
      }
      break;
    case "size":
      match = getSizeOrder(value) === getSizeOrder(item.contentSize);
      break;
    case "larger-than":
      match = item.contentSize > value;
      break;
    case "mime-type":
      match = item.mimeType.includes(value);
      break;
    case "is":
      if (value === "from-cache" ||
          value === "cached") {
        match = item.fromCache || item.status === "304";
      } else if (value === "running") {
        match = !item.status;
      }
      break;
    case "scheme":
      let scheme = new URL(item.url).protocol.replace(":", "").toLowerCase();
      match = scheme === value;
      break;
  }
  if (negative) {
    return !match;
  }
  return match;
}

function isTextFilterMatch({ url }, text) {
  let lowerCaseUrl = url.toLowerCase();
  let lowerCaseText = text.toLowerCase();
  let textLength = text.length;
  // Support negative filtering
  if (text.startsWith("-") && textLength > 1) {
    lowerCaseText = lowerCaseText.substring(1, textLength);
    return !lowerCaseUrl.includes(lowerCaseText);
  }

  // no text is a positive match
  return !text || lowerCaseUrl.includes(lowerCaseText);
}

function isFreetextMatch(item, text) {
  if (!text) {
    return true;
  }

  let filters = parseFilters(text);
  let match = true;

  for (let textFilter of filters.text) {
    match = match && isTextFilterMatch(item, textFilter);
  }

  for (let flagFilter of filters.flags) {
    match = match && isFlagFilterMatch(item, flagFilter);
  }

  return match;
}

module.exports = {
  isFreetextMatch,
};
