import { homedir } from 'node:os';
import { join } from 'node:path';
const home = homedir();
const env = (key, fallback) => process.env[key] || fallback;
export const xdg = {
    config: (...segments) => join(env('XDG_CONFIG_HOME', join(home, '.config')), ...segments),
    data: (...segments) => join(env('XDG_DATA_HOME', join(home, '.local', 'share')), ...segments),
    state: (...segments) => join(env('XDG_STATE_HOME', join(home, '.local', 'state')), ...segments),
    cache: (...segments) => join(env('XDG_CACHE_HOME', join(home, '.cache')), ...segments),
    runtime: (...segments) => join(env('XDG_RUNTIME_DIR', join(home, '.local', 'run')), ...segments),
};
//# sourceMappingURL=xdg.js.map