/**
 * KEV - A Redis-style KV store for environment variables
 *
 * DEFAULT USAGE (no namespaces needed!):
 *   apiKey = KEV.mustGet("API_KEY")      // Panics if not found (required config)
 *   apiKey = KEV.get("API_KEY")          // Returns "" if not found
 *   apiKey = KEV.get("API_KEY", "dev")   // Returns "dev" if not found
 *   port = KEV.int("PORT", 8080)         // With type conversion
 *   KEV.set("DEBUG", "true")             // Sets in memory (fast)
 *
 *   KEV.get("DATABASE_URL")              // memory → process.env → .env → cache result
 *   KEV.get("DATABASE_URL")              // memory (cached!) ✓
 *
 * CUSTOMIZE THE SEARCH ORDER:
 *   KEV.source.remove("os")              // Ignore OS env (perfect for tests!)
 *   KEV.source.add(".env.local")         // Add more fallbacks
 *   KEV.source.set(".env.test")          // Or replace entirely
 *
 * REDIS-STYLE NAMESPACING (when you need control):
 *   KEV.get("os:PATH")                   // ONLY from OS, no fallback
 *   KEV.get(".env:API_KEY")              // ONLY from .env file
 *   KEV.set("os:DEBUG", "true")          // Write directly to OS
 *   KEV.set(".env:API_KEY", "secret")    // Update .env file
 *
 *   // Pattern matching
 *   KEV.keys("API_*")                    // Find all API_ keys
 *   KEV.all("os:*")                      // Get all OS vars
 *   KEV.clear("TEMP_*")                  // Clean up temp vars
 *
 * SOURCE TRACKING & OBSERVABILITY:
 *   const [value, source] = KEV.getWithSource("API_KEY")  // Returns value + where it came from
 *   source = KEV.sourceOf("API_KEY")                      // "/path/to/project/.env"
 *   KEV.debug = true                                       // Shows lookup chain
 *   KEV.export("backup.env")                              // Includes # from: comments
 */
interface MemEntry {
    value: string;
    source: string;
}
declare class SourceOps {
    private kev;
    constructor(kev: KevOps);
    /**
     * Replace all sources
     */
    set(...sources: string[]): void;
    /**
     * Add sources to the search list
     */
    add(...sources: string[]): void;
    /**
     * Remove specific sources
     */
    remove(...sources: string[]): void;
    /**
     * List current sources
     */
    list(): string[];
    /**
     * Clear all sources
     */
    clear(): void;
}
export declare class KevOps {
    memory: Map<string, MemEntry>;
    sources: string[];
    source: SourceOps;
    debug: boolean;
    constructor();
    initializeSmartDefaults(): void;
    parseKey(key: string): [string, string];
    /**
     * Get environment variable with optional default.
     */
    get(key: string, defaultValue?: string): string;
    /**
     * Get environment variable or panic if not found
     */
    mustGet(key: string): string;
    /**
     * Get where a cached key came from
     */
    sourceOf(key: string): string;
    /**
     * Get both value and its source
     */
    getWithSource(key: string, defaultValue?: string): [string, string];
    getFromNamespace(namespace: string, key: string): string;
    getFromFile(filePath: string, key: string): string;
    /**
     * Set environment variable
     */
    set(key: string, value: string): void;
    setToNamespace(namespace: string, key: string, value: string): void;
    setToFile(path: string, key: string, value: string): void;
    /**
     * Check if key exists
     */
    has(key: string): boolean;
    hasInNamespace(namespace: string, key: string): boolean;
    /**
     * Get all keys matching pattern
     */
    keys(pattern?: string): string[];
    keysFromNamespace(namespace: string, pattern: string): string[];
    getNamespaceData(namespace: string, pattern: string, keysOnly: boolean): Record<string, string>;
    parseEnvFile(path: string, pattern: string, result: Record<string, string>, keysOnly: boolean): void;
    matchPattern(key: string, pattern: string): boolean;
    /**
     * Get all variables matching patterns
     */
    all(pattern?: string | string[]): Record<string, Record<string, string>>;
    getAllFromNamespace(namespace: string, pattern: string): Record<string, string>;
    /**
     * Clear variables from memory
     */
    clear(...patterns: string[]): void;
    /**
     * Clear from namespaces (dangerous!)
     */
    clearUnsafe(...patterns: string[]): void;
    /**
     * Remove specific keys
     */
    unset(...keys: string[]): void;
    /**
     * Get as integer with default
     */
    int(key: string, defaultValue: number): number;
    /**
     * Get as boolean with default
     */
    bool(key: string, defaultValue: boolean): boolean;
    /**
     * Get as float with default
     */
    float(key: string, defaultValue: number): number;
    /**
     * Export all memory variables to a file
     */
    export(path: string): void;
    /**
     * Print all environment variables (masks sensitive keys)
     */
    dump(): void;
}
export declare const kev: KevOps;
export {};
//# sourceMappingURL=kev.d.ts.map