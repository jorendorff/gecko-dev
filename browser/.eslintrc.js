"use strict";

module.exports = {
  "extends": [
    "plugin:mozilla/recommended"
  ],

  "rules": {
    // XXX Bug 1326071 - This should be reduced down - probably to 20 or to
    // be removed & synced with the mozilla/recommended value.
    "complexity": ["error", {"max": 42}],

    "no-shadow": "error",
  }
};
