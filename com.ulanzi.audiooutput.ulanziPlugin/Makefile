.DEFAULT_GOAL := package

PLUGIN_NAME := $(notdir $(CURDIR))
TAG_PREFIX := audiooutput
VERSION := $(shell node -p "require('./manifest.json').Version")
OUT := release/$(PLUGIN_NAME)-$(VERSION).zip
INSTALL_DIR := /mnt/c/Users/user/AppData/Roaming/Ulanzi/UlanziDeck/Plugins/$(PLUGIN_NAME)

FILES := manifest.json package.json dist assets property-inspector libs scripts en.json zh_CN.json zh_HK.json

.PHONY: build package install verify clean bump release

build:
	npm ci
	npm run build

package: build
	mkdir -p release
	rm -f $(OUT)
	cd .. && zip -r "$(PLUGIN_NAME)/$(OUT)" $(addprefix $(PLUGIN_NAME)/,$(FILES)) -x '*/node_modules/*' '*/package-lock.json' '*/webpack.config.js' '*/Makefile' '*/release/*' '*/test/*' '*.zip'
	@echo "packaged: $(OUT)"

install: build
	mkdir -p "$(INSTALL_DIR)"
	rsync -a --delete-excluded \
		--exclude 'node_modules/' \
		--exclude 'package-lock.json' \
		--exclude 'webpack.config.js' \
		--exclude 'Makefile' \
		--exclude 'release/' \
		--exclude '*.zip' \
		--exclude 'plugin/' \
		--exclude 'test/' \
		./ "$(INSTALL_DIR)/"
	@echo "installed: $(INSTALL_DIR)"
	@echo "restart Ulanzi Studio to reload"

verify:
	npm test
	unzip -l $(OUT)
	node -e "const m=require('./manifest.json'); console.log(m.UUID, m.Version, m.Actions.map(a=>a.UUID).join(','))"
	test -f dist/app.js
	test -f scripts/Get-AudioState.ps1
	test -f scripts/Set-DefaultAudioDevice.ps1

# 改 manifest.json + 根 README 版本表，只動檔不 commit
bump:
	@test -n "$(V)" || { echo "usage: make bump V=1.0.1"; exit 1; }
	@node ../scripts/bump.mjs "$(PLUGIN_NAME)" "$(V)"

# 建 tag、push、發 GitHub release（附 zip）
release:
	@../scripts/release.sh "$(PLUGIN_NAME)" "$(TAG_PREFIX)"

clean:
	rm -rf release
