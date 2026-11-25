# Liquid Select

Original: https://21st.dev/@liquefy-ui/components/liquid-select

Registry: https://liquefy-ui.com/r/liquid-select.json

Retrieved 2026-11-10 through the subscribed 21st connector and the author's public registry. MIT license. Runtime dependencies pinned to `@base-ui/react@1.9.0` and `@liquefy-ui/core@1.2.0`.

The original Liquid Glass hook, shaders, glyphs, style helpers and CSS are retained. Local source changes are relative import paths, native optgroup support, a stable portal slot inside the nearest dialog/popover/menu, and fixed positioning so card overflow does not clip the popup. The slot keeps React teardown valid when a native owner replaces its contents. Astarter colors and control sizing live in the shared interface stylesheet. Form values and events remain on the original select nodes through `liquid-select.jsx`; application business handlers are unchanged.

The shared core owns one WebGL drawing context for trigger surfaces; each surface uses a 2D blit. The original destroy hooks release each surface's animation frames, observers and pointer listeners. Reduced-motion settings disable both the motion and lens controllers.
