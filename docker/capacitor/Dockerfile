# The Capacitor toolchain for the WebView app build (`docs/go_webview.md` §9), in a container
# for the same reason as docker/android/: "can you build the app?" must not depend on which
# JDK and which SDK packages happen to be installed on somebody's laptop.
#
# **Why this is a second image rather than a flag on the first one.** docker/android/ exists
# for Bubblewrap and is pinned to JDK 17, which is what Bubblewrap asks for and what its
# generated project builds with. The Capacitor project compiles at Java 21 — see
# `front/src-capacitor/android/app/capacitor.build.gradle`, which Capacitor regenerates on
# every `cap sync` with `sourceCompatibility JavaVersion.VERSION_21` — under AGP 8.13.0 and
# Gradle 8.14.3. One image cannot hold both `JAVA_HOME` values without a per-command
# override, and an image that is only correct when someone remembers a flag is an image that
# will one day be run without it.
#
# Node, not a JDK image, as the base: this container also runs `npm install` and
# `npx cap sync`, because Gradle cannot resolve the plugin subprojects until
# `src-capacitor/node_modules` exists (`capacitor.settings.gradle` points at paths inside it).
#
# **trixie, not the bookworm that docker/android/ uses, and that is the only reason for the
# difference.** Debian 12 has no openjdk-21 anywhere — not in main, not in bookworm-backports,
# which was tried first and fails with "Unable to locate package". Debian 13 carries it in
# main, so the base image bump replaces a third-party JDK repo or a hand-unpacked tarball.
FROM node:24.15.0-trixie

# `-headless` because nothing here draws a window.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    openjdk-21-jdk-headless \
    unzip \
    && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
ENV ANDROID_HOME=/opt/android-sdk

# Pinned rather than "latest", and every version here is dictated by a file in the generated
# project rather than chosen:
#
#   - platform 36     — `variables.gradle` sets compileSdk/targetSdk = 36, and Play requires
#                       36 of new apps from 31 Aug 2026.
#   - build-tools     — `app/build.gradle` pins `buildToolsVersion` to exactly this. That pin
#                       exists so this line is a fact and not a guess: without it AGP picks
#                       its own default and shells out to `sdkmanager` mid-build — over the
#                       network, in a `--rm` container — which is the one thing this image
#                       exists to prevent. Change one, change the other.
#
# `platform-tools` is deliberately absent: it is adb, and a container has no USB. Sideload
# from the host.
ARG CMDLINE_TOOLS_VERSION=13114758
ARG ANDROID_PLATFORM=android-36
ARG ANDROID_BUILD_TOOLS=36.0.0

# `sdkmanager` insists on living in cmdline-tools/latest/, and unzips into a bare
# cmdline-tools/ — hence the move.
RUN mkdir -p ${ANDROID_HOME} \
    && curl -fsSL -o /tmp/tools.zip \
    "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip" \
    && unzip -q /tmp/tools.zip -d /tmp/tools \
    && mkdir -p ${ANDROID_HOME}/cmdline-tools \
    && mv /tmp/tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
    && rm -rf /tmp/tools.zip /tmp/tools

ENV PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${PATH}"

# Accepting the licences at build time is what keeps every later command non-interactive.
RUN yes | sdkmanager --licenses > /dev/null \
    && sdkmanager --install \
    "platforms;${ANDROID_PLATFORM}" \
    "build-tools;${ANDROID_BUILD_TOOLS}" \
    > /dev/null

ARG USER_ID=1000
ARG GROUP_ID=1000
RUN userdel node \
    && groupadd -g ${GROUP_ID} app \
    && useradd -u ${USER_ID} -g ${GROUP_ID} -m app \
    && echo 'HISTFILE=/home/app/.bash_history' >> /home/app/.bashrc \
    && echo 'HISTSIZE=1000' >> /home/app/.bashrc \
    && echo 'HISTFILESIZE=2000' >> /home/app/.bashrc \
    && echo 'PROMPT_COMMAND="history -a"' >> /home/app/.bashrc \
    # Gradle writes metadata into the SDK directory, so it cannot stay root-owned.
    && chown -R app:app ${ANDROID_HOME}

USER app

# Both are mount points in docker-compose.yml, and both are created **after** `USER app` on
# purpose: Docker seeds a fresh named volume from the image path and copies its ownership, so a
# directory made while still root produces a root-owned volume that npm then refuses to use
# ("Your cache folder contains root-owned files"). Creating them here as `app` is what makes
# the mounts writable.
RUN mkdir -p /home/app/.gradle /home/app/.npm

WORKDIR /work

# The node base image's entrypoint guesses: anything it does not recognise as a system command
# gets `node` put in front of it, so `run capacitor ./gradlew assembleDebug` would be handed
# to Node as a JS module. Nothing here is ever a script for Node to run — the commands are
# npm, npx, gradle and bash — so the guessing is only ever wrong.
ENTRYPOINT []

CMD ["sleep", "infinity"]
