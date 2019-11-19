module.exports = {
    parser: '@typescript-eslint/parser',
    parserOptions: {
        ecmaVersion: 6,
        sourceType: 'module',
        ecmaFeatures: {
            modules: true,
        },
    },
    plugins: [
        '@typescript-eslint',
    ],
    rules: {
        'eol-last': 2,
        'no-multiple-empty-lines': ['error', {
            'max': 1,
            'maxEOF': 1,
            'maxBOF': 0,
        }],
        'comma-dangle': ['error', {
            arrays: 'always-multiline',
            objects: 'always-multiline',
            imports: 'ignore',
            exports: 'ignore',
            functions: 'ignore',
        }],
        'no-duplicate-imports': ['error', {
            'includeExports': true,
        }],
        'no-var': 'error',
        'prefer-const': 'error',
        'prefer-rest-params': 'error',
        'prefer-spread': 'error',
        '@typescript-eslint/adjacent-overload-signatures': 'error',
        "brace-style": "off",
        "@typescript-eslint/brace-style": ["error"],
    },
}
