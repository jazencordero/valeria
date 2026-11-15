/**
 * Room a page leaves at its bottom so the floating notes button (notepad.css,
 * `.pad-fab`) never sits on the last row's action while she is not scrolling.
 * On a phone the button spans 18 to 74 px above the tab bar; on wide screens
 * 24 to 80 px above the bottom. 96 px clears both with a gap. A plain module, so
 * server pages can read the class (a "use client" module's exports are client
 * references there).
 */
export const FAB_CLEAR = "pb-[96px]";
export const FAB_CLEAR_WIDE = "min-[700px]:pb-[96px]";
