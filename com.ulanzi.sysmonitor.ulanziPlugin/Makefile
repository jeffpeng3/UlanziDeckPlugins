.DEFAULT_GOAL := package

PLUGIN_NAME := $(notdir $(CURDIR))
VERSION := $(shell node -p "require('./manifest.json').Version")
OUT := release/$(PLUGIN_NAME)-$(VERSION).zip
INSTALL_DIR := /mnt/c/Users/user/AppData/Roaming/Ulanzi/UlanziDeck/Plugins/$(PLUGIN_NAME)
HELPER_EXE := bin/win-x64/winquery.exe

FILES := manifest.json package.json dist assets property-inspector libs bin en.json zh_CN.json zh_HK.json

.PHONY: build package install verify clean helper

build:
	npm install
	npm run build

# Rust 查詢器跨編譯，失敗不擋打包（Node 會退回 powershell）
helper:
	if command -v cargo >/dev/null 2>&1; then \
		mkdir -p bin/win-x64; \
		(cd helpers/winquery && cargo build --release --target x86_64-pc-windows-gnu) && cp helpers/winquery/target/x86_64-pc-windows-gnu/release/winquery.exe $(HELPER_EXE) && echo "helper: $(HELPER_EXE)" || echo "helper: build failed, skip (powershell fallback)"; \
	else \
		echo "helper: cargo not found, skip"; \
	fi

package: build helper
	mkdir -p release
	rm -f $(OUT)
	cd .. && zip -r "$(PLUGIN_NAME)/$(OUT)" $(addprefix $(PLUGIN_NAME)/,$(FILES)) -x '*/node_modules/*' '*/package-lock.json' '*/webpack.config.js' '*/Makefile' '*/release/*' '*.zip'
	@echo "packaged: $(OUT)"

install: build helper
	mkdir -p "$(INSTALL_DIR)"
	# 跑中的 helper 會鎖住 exe，先砍掉，插件會自動重起
	if command -v taskkill.exe >/dev/null 2>&1; then taskkill.exe /F /IM winquery.exe >/dev/null 2>&1 || true; fi
	rsync -a --delete-excluded \
		--exclude 'node_modules/' \
		--exclude 'package-lock.json' \
		--exclude 'webpack.config.js' \
		--exclude 'Makefile' \
		--exclude 'release/' \
		--exclude '*.zip' \
		--exclude 'plugin/' \
		--exclude 'helpers/' \
		./ "$(INSTALL_DIR)/"
	@echo "installed: $(INSTALL_DIR)"
	@echo "restart Ulanzi Studio to reload"

verify:
	unzip -l $(OUT)
	node -e "const m=require('./manifest.json'); console.log(m.UUID, m.Version, m.Actions.map(a=>a.UUID).join(','))"
	test -f dist/app.js

clean:
	rm -rf release
