# Changelog

This file starts at 0.8.0, the first release with a breaking change worth
calling out. Earlier releases are in the git history (`git log --oneline v0.7.6`).

## 0.8.0

### Breaking: state readers must declare a description

`window.aiState` entries are now objects, not bare functions:

```js
window.aiState = {
  text: {
    description: "the text the user wants to annotate",
    read: function() { return $("#text").val() || ""; }
  }
};
```

The bare-function form (`text: function() {…}`) is **removed**, with no fallback.
A key still using it is reported to the console by name, with the shape it should
have, and skipped — the page's other readers keep working.

**Why.** Every other channel the widget declares to the model already carries a
developer-authored description: Class 3 action schemas, Class 2 `.well-known`
tools, Class 1 hub-registered tools, static-primitives resources. State readers
were the exception — the model saw a bare key and inferred meaning from its name.
That holds for `text` and fails for `annotation_mode` or `pending_merges`.

**What to change.** Wrap each reader in `{ description, read }`. The description
is the place to tell the model what it must know about the value, not merely what
the value is — an enumeration it must choose from, a unit, a null convention.

The system prompt now renders one line per reader with the description inline:

```
Current page state:
- text (the text the user wants to annotate): "The stomach was examined."
- selected_dictionaries (the dictionaries the user has chosen): ["uberon"]
```

Prompt-argument pre-filling (`promptArgFromState`) reads the same shape, so a
page left on the old form also stops pre-filling prompt arguments.
