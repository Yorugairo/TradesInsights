/**
 * Tailwind v4 is wired through its own PostCSS plugin package.
 *
 * GOTCHA worth stating in the config itself: v3's plugin was the `tailwindcss`
 * package. In v4 that package no longer exports a PostCSS plugin, and naming it
 * here fails SILENTLY — the build succeeds, every utility class is dropped, and
 * the app renders unstyled with no error to point at. If styles ever vanish
 * wholesale, check this line first.
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
