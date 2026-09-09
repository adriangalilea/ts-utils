# TODO

- [ ] **Action registry (the web twin of swift-utils' shortcut package).** An ActionID-shaped registry as data: id, title, symbol/icon, scope, default bindings, one `perform()` funnel. Everything derives from it so nothing can drift: keyboard bindings, a command palette / menu, the `?` cheat-sheet overlay, a remap store with conflicts rejected by name. Motivated by the studio decree (untitled CLAUDE.md, Brand rules, 2026-07-27): every app MUST be fully keyboard navigable, web included - real focus order, arrow-key cursor over lists/grids/kanbans, `?` for live bindings. The proven model is lore's `Actions.swift` spine; the Swift side SHIPPED: github.com/adriangalilea/swift-utils (Keymap - registry, remap store with named-owner conflicts, cheat panel, which-key reveal). Cross-stack rule from there applies here too: share the SHAPE, not code - define what each stack requires of the other before coupling anything.
- [ ] **East-Asian width in `cli`.** `width()` counts grapheme clusters, so
  CJK and wide emoji (two terminal cells each) measure as one and columns
  drift a cell per wide grapheme. Needs a wcwidth range table.
- [ ] **Global charge index for `bot/payments`.** Charge indexes are per user,
  so `exportPayouts` cannot fill its `charges` field and callers have to pass
  an explicit user-id list to `exportPayoutsForUsers`.
- [ ] **Deep-link `require()` to an exact VIP rung.** `menuNavCb` addresses a
  menu item, not a rung inside one, so the upgrade button can only open the
  VIP root.
