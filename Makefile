publish:
	bash scripts/release/publish.sh --approve

test:
	cargo build --release && node scripts/smoke-install.js && node scripts/test-lifecycle.js

.PHONY: publish test
