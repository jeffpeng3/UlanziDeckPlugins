.DEFAULT_GOAL := package

PLUGIN_NAME := $(notdir $(CURDIR))
VERSION := $(shell node -p "require('./manifest.json').Version")
OUT := release/$(PLUGIN_NAME)-$(VERSION).zip
INSTALL_DIR := /mnt/c/Users/user/AppData/Roaming/Ulanzi/UlanziDeck/Plugins/$(PLUGIN_NAME)

FILES := manifest.json package.json dist assets property-inspector libs scripts en.json zh_CN.json zh_HK.json

.PHONY: build package install verify clean

build:
	npm install
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

clean:
	rm -rf release
