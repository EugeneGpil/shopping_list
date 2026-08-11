.PHONY: help setup build up down restart logs php node migrate fresh artisan composer \
	android android-update android-shell android-build android-debug

help:
	@echo ""
	@echo "  make setup      First-time project setup"
	@echo "  make build      Build all services"
	@echo "  make up         Start all services"
	@echo "  make down       Stop all services"
	@echo "  make restart    Restart all services"
	@echo "  make logs       Tail all logs"
	@echo "  make php        Shell into PHP container"
	@echo "  make node       Shell into Node container"
	@echo "  make migrate    Run migrations"
	@echo "  make fresh      Fresh migrate + seed"
	@echo "  make artisan    Run artisan (make artisan CMD='route:list')"
	@echo "  make composer   Run composer (make composer CMD='require ...')"
	@echo ""
	@echo "  Android / Play (see docs/publish_todo.md B0)"
	@echo "  make android-update     Regenerate twa/ from twa-manifest.json"
	@echo "  make android CMD='...'  Run any bubblewrap command in the toolchain container"
	@echo "  make android-debug      Build a debug APK — no keystore, no secrets needed"
	@echo "  make android-build      Build the signed AAB + APK for Play (needs the keystore)"
	@echo "  make android-shell      Shell into the Android toolchain container"
	@echo ""

setup:
	@chmod +x setup.sh && ./setup.sh

build:
	docker compose build

up:
	docker compose up -d

down:
	docker compose down

restart:
	docker compose restart

logs:
	docker compose logs -f

php:
	docker compose exec php bash

node:
	docker compose exec node bash

migrate:
	docker compose exec php php artisan migrate

fresh:
	docker compose exec php php artisan migrate:fresh --seed

artisan:
	docker compose exec php php artisan $(CMD)

composer:
	docker compose exec php composer $(CMD)

# The Android toolchain is a one-shot builder behind a compose profile, so these use `run
# --rm` rather than `exec`: there is no long-running container to attach to, and every
# invocation gets the same pinned JDK, SDK and Bubblewrap whatever the host has installed.
#
# `--rm` and nothing else persisted: the generated project lives in ./twa (bind-mounted), so
# a discarded container loses only the container.
android:
	USER_ID=$(shell id -u) GROUP_ID=$(shell id -g) \
		docker compose --profile android run --rm android bubblewrap $(CMD)

# Rebuild the Android project from twa/twa-manifest.json — the only file in twa/ that is
# versioned, so this is what a fresh clone (or anything that removed ignored files, e.g.
# `git clean -x`) runs before it can build.
#
# `--skipVersionUpgrade` is not optional here: a bare `bubblewrap update` bumps
# appVersionCode, so regenerating on three machines would silently claim three versions. The
# version belongs to a release, not to a regenerate.
android-update:
	USER_ID=$(shell id -u) GROUP_ID=$(shell id -g) \
		docker compose --profile android run --rm android \
		bubblewrap update --skipVersionUpgrade

# Every build depends on the generated project, and the generated project is ignored by git —
# so a `git clean -fdX`, a fresh clone, or anything else that drops ignored files leaves the
# builds with no `gradlew` to run. Making that a real prerequisite means the next build repairs
# it instead of failing: this rule fires when twa/gradlew is missing or older than the manifest
# it is generated from.
TWA_PROJECT := twa/gradlew

$(TWA_PROJECT): twa/twa-manifest.json
	$(MAKE) android-update

# The upload key is the app's permanent identity on Play — lose it and this app can never be
# updated again by anyone — so it lives outside the repo and is bind-mounted read-only for the
# one command that needs it. `twa/` would be the worst possible home for it: `.gitignore` is an
# allowlist there, so `git clean -fdX` empties that directory down to twa-manifest.json and
# would take the key with it. `twa-manifest.json` therefore points `signingKey.path` at the
# mount target, /keys/upload.jks, not at anything under twa/.
#
# Override for a key kept elsewhere: `make android-build KEYSTORE=/path/to/upload.jks`.
KEYSTORE ?= $(HOME)/keys/shopping_list/upload.jks

# The keystore passwords are read from the environment rather than typed, so this is the one
# command that needs secrets. Export them for the call and they stay out of the shell
# history: `BUBBLEWRAP_KEYSTORE_PASSWORD=... BUBBLEWRAP_KEY_PASSWORD=... make android-build`
android-build: $(TWA_PROJECT)
	@test -f "$(KEYSTORE)" || { \
		echo "No upload keystore at $(KEYSTORE)."; \
		echo "Create it once (docs/publish_todo.md section 4) or pass KEYSTORE=<path>."; \
		exit 1; \
	}
	USER_ID=$(shell id -u) GROUP_ID=$(shell id -g) \
		docker compose --profile android run --rm \
		-e BUBBLEWRAP_KEYSTORE_PASSWORD -e BUBBLEWRAP_KEY_PASSWORD \
		-v "$(KEYSTORE):/keys/upload.jks:ro" \
		android bubblewrap build --skipPwaValidation

# Signs with the Android debug key, which Gradle generates by itself — so this is the one
# build anybody can run with no secrets at all. Not installable on Play; it is here to prove
# the toolchain works and to sideload onto a phone (`adb install` the APK it prints).
#
# Run through `sh -c` rather than as a bare `./gradlew`: a relative program name is resolved
# by runc against the container's cwd, and the failure when it cannot be — `stat ./gradlew: no
# such file or directory` — reads like a broken image rather than a missing file.
android-debug: $(TWA_PROJECT)
	USER_ID=$(shell id -u) GROUP_ID=$(shell id -g) \
		docker compose --profile android run --rm android \
		sh -c 'cd /work && exec ./gradlew --no-daemon assembleDebug'
	@echo "APK: twa/app/build/outputs/apk/debug/app-debug.apk"

android-shell:
	USER_ID=$(shell id -u) GROUP_ID=$(shell id -g) \
		docker compose --profile android run --rm android bash
