// `pluralize` ships as a UMD file. In an IIFE bundle there is no `require`, so the UMD
// takes its browser branch and puts the function on `exports.pluralize` instead of
// `module.exports`; in ES builds the bundler's `__require` shim makes it `default`.
// retext-redundant-acronyms and syllable import `pluralize` as a default import, so
// vite.docs-addon.config.ts aliases that bare specifier here.
import * as mod from 'pluralize/pluralize.js'
const m = mod
const pluralize = typeof m.default === 'function' ? m.default : (m.default && m.default.pluralize) || m.pluralize
if (typeof pluralize !== 'function') throw new Error('pluralize failed to load')
export default pluralize
