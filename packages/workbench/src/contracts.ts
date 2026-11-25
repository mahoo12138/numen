/**
 * Public wire contracts for the Workbench product surface.
 *
 * The contracts are split by domain so a change to one area does not require
 * touching an 800-line module. This file stays the single import surface, so
 * `@numenjs/workbench/contracts` remains stable for plugins and the browser.
 */
export * from './attention-contracts.js'
export * from './contracts/automations.js'
export * from './contracts/authoring.js'
export * from './contracts/connections.js'
export * from './contracts/credentials.js'
export * from './contracts/home.js'
export * from './contracts/inspection.js'
export * from './contracts/runs.js'
export * from './contracts/schema.js'
