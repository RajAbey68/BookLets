import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { defineConfig, globalIgnores } from "eslint/config";

const eslintConfig = defineConfig([
	...nextVitals,
	...nextTs,
	// Override default ignores of eslint-config-next.
	globalIgnores([
		// Default ignores of eslint-config-next:
		".next/**",
		"out/**",
		"build/**",
		"next-env.d.ts",
		// Generated coverage reports (RAJ-279): never lint vitest coverage output.
		"coverage/**",
		// Root-level one-off maintenance scripts — CommonJS, not part of the app bundle.
		"pg_test.js",
		"supabase_automation.js",
	]),
]);

export default eslintConfig;
