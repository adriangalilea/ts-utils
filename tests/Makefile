.PHONY: all example turborepo clean help

# Default target
all: example turborepo
	@echo "✅ All tests completed"

# Run the example test
example:
	@echo "🧪 Running example test..."
	@cd .. && npm run example

# Run the turborepo monorepo test
turborepo:
	@echo "🧪 Running turborepo test..."
	@cd turborepo/apps/api && npm run dev

# Clean node_modules in test directories
clean:
	@echo "🧹 Cleaning test dependencies..."
	@rm -rf turborepo/node_modules
	@rm -rf turborepo/apps/api/node_modules
	@echo "✅ Cleaned"

# Install dependencies for tests
install:
	@echo "📦 Installing test dependencies..."
	@cd turborepo && npm install
	@echo "✅ Dependencies installed"

# Run tests with fresh install
fresh: clean install all

# Help target
help:
	@echo "Available targets:"
	@echo "  make all       - Run all tests (default)"
	@echo "  make example   - Run example test"
	@echo "  make turborepo - Run turborepo monorepo test"
	@echo "  make install   - Install test dependencies"
	@echo "  make clean     - Clean test node_modules"
	@echo "  make fresh     - Clean, install, and run all tests"
	@echo "  make help      - Show this help message"