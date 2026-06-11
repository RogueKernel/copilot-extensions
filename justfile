extension := ".github/extensions/copilot-cost"

default:
  @just --list

# Install extension npm dependencies.
deps:
  cd {{extension}} && npm install

# Run all tests.
test:
  cd {{extension}} && npm test

# Run one Node test file, for example: just test-file test/unit/cost.test.mjs
test-file file:
  cd {{extension}} && node --test {{file}}

# Run the closest available lint-like check.
lint:
  cd {{extension}} && npm run check

# Syntax-check the extension entrypoint.
check:
  cd {{extension}} && npm run check

# Smoke-test the statusline runtime.
smoke:
  cd {{extension}} && npm run smoke:statusline

# Run the full validation suite.
validate:
  cd {{extension}} && npm run validate

# Update extension npm dependencies.
update-deps:
  cd {{extension}} && npm update
