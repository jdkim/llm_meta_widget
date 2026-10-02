import globals from "globals"

// Deliberately narrow: this is a bug net, not a style guide. Every rule here
// corresponds to a bug that actually reached a browser in this project.
export default [
  // Vendored third-party bundle, and our own generated bundle — neither is
  // ours to lint or fix. The panel's script used to be extracted out of the
  // ERB template so ESLint could see it (tmp/panel_script.js); it is now a
  // real module, element.js, so the extractor is gone.
  { ignores: [
      "app/assets/javascripts/llm_meta_widget/marked.esm.js",
      "app/assets/javascripts/llm_meta_widget/llm-meta-widget.js",
  ] },
  {
    files: [ "app/assets/javascripts/**/*.js" ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, marked: "readonly" }
    },
    rules: {
      "no-undef": "error",            // `panel` instead of `root`
      "no-shadow": "error",           // a `label` parameter hidden by a `label` local
      // An empty catch binding is deliberate throughout: optional work that
      // must never break the page.
      "no-unused-vars": [ "error", { args: "none", caughtErrors: "none" } ],
      "no-redeclare": "error"
    }
  },
  {
    files: [ "app/assets/javascripts/**/*.test.mjs" ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node }
    },
    rules: { "no-unused-vars": [ "error", { args: "none", caughtErrors: "none" } ] }
  }
]
