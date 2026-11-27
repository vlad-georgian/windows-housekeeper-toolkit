import { defineConfig } from 'vite-plus'

export default defineConfig({
    lint: {
        categories: { correctness: 'deny', suspicious: 'warn', perf: 'warn' },
        env: { builtin: true, node: true },
        ignorePatterns: ['node_modules/', 'logs/'],
        options: { denyWarnings: true, typeAware: true, typeCheck: true },
        plugins: ['typescript', 'unicorn', 'oxc', 'import'],
        rules: { 'no-await-in-loop': 'off' }
    },
    fmt: {
        ignorePatterns: ['node_modules/', 'logs/', 'bun.lock'],
        printWidth: 180,
        semi: false,
        singleQuote: true,
        sortImports: true,
        sortPackageJson: true,
        tabWidth: 4,
        trailingComma: 'none'
    }
})
