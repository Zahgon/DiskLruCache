import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      // The cache mirrors a Java API whose accessors are methods, not fields.
      '@typescript-eslint/class-literal-property-style': 'off',
      // Error messages and journal records interpolate value counts, indices
      // and byte lengths, exactly as the original's string concatenation does.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Overrides that deliberately ignore an argument name it for the reader.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    ignores: ['dist/**', 'coverage/**'],
  },
);
