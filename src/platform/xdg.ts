import { homedir } from 'node:os'
import { join } from 'node:path'

const home = homedir()
const env = (key: string, fallback: string) => process.env[key] || fallback

export const xdg = {
  config:  (...segments: string[]) => join(env('XDG_CONFIG_HOME', join(home, '.config')), ...segments),
  data:    (...segments: string[]) => join(env('XDG_DATA_HOME', join(home, '.local', 'share')), ...segments),
  state:   (...segments: string[]) => join(env('XDG_STATE_HOME', join(home, '.local', 'state')), ...segments),
  cache:   (...segments: string[]) => join(env('XDG_CACHE_HOME', join(home, '.cache')), ...segments),
  runtime: (...segments: string[]) => join(env('XDG_RUNTIME_DIR', join(home, '.local', 'run')), ...segments),
}
