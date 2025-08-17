import { file } from './file.js'
import { dir } from './dir.js'
import { path } from './path.js'

/**
 * Find project root by walking up from current directory looking for project markers.
 * Checks for: package.json, tsconfig.json, .git, deno.json
 */
export function findProjectRoot(): string {
  const cwd = process.cwd()
  return findProjectRootFrom(cwd)
}

/**
 * Find project root from a specific directory
 */
export function findProjectRootFrom(startDir: string): string {
  let currentDir = startDir

  while (true) {
    // Check for TypeScript/JavaScript project markers
    if (file.exists(path.join(currentDir, 'package.json'))) {
      return currentDir
    }
    if (file.exists(path.join(currentDir, 'tsconfig.json'))) {
      return currentDir
    }
    if (dir.exists(path.join(currentDir, '.git'))) {
      return currentDir
    }
    if (file.exists(path.join(currentDir, 'deno.json'))) {
      return currentDir
    }
    if (file.exists(path.join(currentDir, 'deno.jsonc'))) {
      return currentDir
    }

    // Move up one directory
    const parent = path.dirname(currentDir)

    // Stop at filesystem root
    if (parent === currentDir) {
      break
    }

    currentDir = parent
  }

  return ''
}

/**
 * Find monorepo root by walking up looking for turborepo markers.
 * Checks for: turbo.json, pnpm-workspace.yaml, lerna.json
 */
export function findMonorepoRoot(): string {
  const cwd = process.cwd()
  return findMonorepoRootFrom(cwd)
}

/**
 * Find monorepo root from a specific directory
 */
export function findMonorepoRootFrom(startDir: string): string {
  let currentDir = startDir

  while (true) {
    // Check for turbo.json (turborepo)
    const turboPath = path.join(currentDir, 'turbo.json')
    if (file.exists(turboPath)) {
      if (isTurboRepo(turboPath)) {
        return currentDir
      }
    }

    // Check for pnpm workspace
    if (file.exists(path.join(currentDir, 'pnpm-workspace.yaml'))) {
      return currentDir
    }

    // Check for lerna
    if (file.exists(path.join(currentDir, 'lerna.json'))) {
      return currentDir
    }

    // Check for npm/yarn workspaces (package.json with workspaces field)
    const pkgPath = path.join(currentDir, 'package.json')
    if (file.exists(pkgPath)) {
      try {
        const pkg = JSON.parse(file.readText(pkgPath))
        if (pkg.workspaces) {
          return currentDir
        }
      } catch {
        // Not a valid package.json, continue
      }
    }

    // Move up one directory
    const parent = path.dirname(currentDir)

    // Stop at filesystem root
    if (parent === currentDir) {
      break
    }

    currentDir = parent
  }

  return ''
}

/**
 * Check if a turbo.json file is a valid turborepo config
 */
function isTurboRepo(turboJsonPath: string): boolean {
  try {
    const content = file.readText(turboJsonPath)
    const config = JSON.parse(content)
    
    // Check for turborepo-specific fields
    // A valid turbo.json should have "pipeline" or "tasks" field
    return 'pipeline' in config || 'tasks' in config
  } catch {
    return false
  }
}

/**
 * Get the nearest package.json data
 */
export function getPackageJson(): any | null {
  const root = findProjectRoot()
  if (!root) return null

  const pkgPath = path.join(root, 'package.json')
  if (!file.exists(pkgPath)) return null

  try {
    return JSON.parse(file.readText(pkgPath))
  } catch {
    return null
  }
}

/**
 * Check if current project is a TypeScript project
 */
export function isTypeScriptProject(): boolean {
  const root = findProjectRoot()
  if (!root) return false

  // Check for tsconfig.json
  if (file.exists(path.join(root, 'tsconfig.json'))) return true
  
  // Check for TypeScript in dependencies
  const pkg = getPackageJson()
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    return 'typescript' in deps
  }

  return false
}

export const project = {
  findProjectRoot,
  findProjectRootFrom,
  findMonorepoRoot,
  findMonorepoRootFrom,
  getPackageJson,
  isTypeScriptProject,
}

export default project