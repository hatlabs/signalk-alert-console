import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  eslintConfigPrettier,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.tools.json'],
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    files: ['**/*.ts', 'tools/**/*.mjs'],
    rules: {
      eqeqeq: ['error', 'always'],
      'no-return-assign': ['error', 'always'],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-inferrable-types': 'off'
    }
  },
  {
    // tsconfig.tools.json type-checks the tools against Node's globals.
    files: ['tools/**/*.mjs'],
    rules: {
      'no-undef': 'off'
    }
  },
  {
    // Lit calls @event listeners with the host element as `this`.
    files: ['src/components/**/*.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off'
    }
  },
  {
    ignores: ['node_modules/**', 'coverage/**', 'public/**', 'src/public/**', '*.config.{js,ts}']
  }
)
