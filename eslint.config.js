const js = require("@eslint/js");
const globals = require("globals");
module.exports = [
  js.configs.recommended,
  { files: ["app.js"], languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: { ...globals.browser, firebase: "readonly" } } },
  { files: ["sw.js"], languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: { ...globals.serviceworker } } },
  { files: ["functions/**/*.js", "eslint.config.js"], languageOptions: { ecmaVersion: 2022, sourceType: "commonjs", globals: { ...globals.node } } },
  { rules: { "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }], "no-empty": ["warn", { allowEmptyCatch: true }] } },
];
