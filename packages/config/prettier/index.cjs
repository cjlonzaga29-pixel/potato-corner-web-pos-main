/**
 * Shared Prettier rules. The root `.prettierrc` is the single source of truth
 * Prettier itself reads from; this module exists so tooling that wants to
 * import config programmatically (rather than relying on file discovery) can.
 */
module.exports = {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
  plugins: ['prettier-plugin-tailwindcss'],
};
