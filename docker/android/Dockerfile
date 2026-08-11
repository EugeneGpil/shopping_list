# The Android toolchain for the Play build (`docs/publish_todo.md` B0), in a container so
# that "can you build the app?" does not depend on which JDK and which SDK packages happen
# to be installed on somebody's laptop. Everything the build needs is pinned here.
#
# Node, not a JDK image, as the base: Bubblewrap is an npm CLI and is the thing being run —
# the JDK is installed below and is what it shells out to.
FROM node:24.15.0-bookworm

# JDK 17 headless is what Bubblewrap asks for and what the Gradle wrapper in its generated
# project runs on. `-headless` because nothing here draws a window.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    openjdk-17-jdk-headless \
    unzip \
    && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV ANDROID_HOME=/opt/android-sdk

# Pinned rather than "latest": an SDK that changes underneath the project is exactly what
# this container exists to prevent. Bumping these is a deliberate commit.
#
# 36 because that is what Bubblewrap generates (`compileSdkVersion`/`targetSdkVersion` in
# twa/app/build.gradle) and what Play requires of new apps from 31 Aug 2026. These two must
# stay in step with the generated project: an older platform here fails the build outright.
# 36.1.0 rather than 36.0.0 for the build-tools, and that exact version is not a preference:
# Bubblewrap hard-codes `BUILD_TOOLS_VERSION = '36.1.0'` in @bubblewrap/core and signs the
# release with *that* copy of zipalign and apksigner. When it is missing it shells out to
# `sdkmanager --install` mid-build — interactively, in a `--rm` container, over the network —
# which is the one thing this image exists to prevent. Only the signed build (`make
# android-build`) reaches that code path, so nothing caught it until the upload key existed.
# Bumping @bubblewrap/cli means re-checking this constant.
ARG CMDLINE_TOOLS_VERSION=13114758
ARG ANDROID_PLATFORM=android-36
ARG ANDROID_BUILD_TOOLS=36.1.0
# 35.0.0 as well, because the Android Gradle Plugin in Bubblewrap's project declares no
# `buildToolsVersion` and falls back to its own default of 35. Without it here, Gradle
# downloads it inside the container on *every* build and `--rm` throws it away again — a
# silent per-build download, and a network dependency in a container that exists to not have
# one. Both are pinned so a build needs nothing from Google at run time.
ARG ANDROID_BUILD_TOOLS_AGP=35.0.0

# `sdkmanager` insists on living in cmdline-tools/latest/, and unzips into a bare
# cmdline-tools/ — hence the move.
RUN mkdir -p ${ANDROID_HOME} \
    && curl -fsSL -o /tmp/tools.zip \
    "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip" \
    && unzip -q /tmp/tools.zip -d /tmp/tools \
    && mkdir -p ${ANDROID_HOME}/cmdline-tools \
    && mv /tmp/tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
    && rm -rf /tmp/tools.zip /tmp/tools \
    # Bubblewrap still checks for the pre-2020 SDK layout: it accepts a path only if
    # <sdk>/tools or <sdk>/bin exists, and looks for sdkmanager at <sdk>/bin/sdkmanager.
    # Neither is where cmdline-tools puts them any more, so `bubblewrap build` rejected this
    # SDK outright with "The provided androidSdk isn't correct." — while `update` and the
    # plain Gradle builds, which never validate, worked fine. One symlink satisfies both
    # lookups without a second copy of the tools.
    && ln -s cmdline-tools/latest/bin ${ANDROID_HOME}/bin

ENV PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${PATH}"

# Accepting the licences at build time is what keeps every later command non-interactive.
RUN yes | sdkmanager --licenses > /dev/null \
    && sdkmanager --install \
    "platform-tools" \
    "platforms;${ANDROID_PLATFORM}" \
    "build-tools;${ANDROID_BUILD_TOOLS}" \
    "build-tools;${ANDROID_BUILD_TOOLS_AGP}" \
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
    # The SDK is written to by sdkmanager if anything is ever added, and Gradle writes its
    # own metadata under here too, so it cannot stay root-owned.
    && chown -R app:app ${ANDROID_HOME}

ENV NPM_CONFIG_PREFIX=/home/app/.npm-global
ENV PATH="/home/app/.npm-global/bin:${PATH}"

USER app

# Pinned for the same reason as the SDK: `init` writes a project whose shape comes from the
# CLI version, and a different one months later would quietly generate something else.
ARG BUBBLEWRAP_VERSION=1.24.1
RUN npm install -g @bubblewrap/cli@${BUBBLEWRAP_VERSION}

# Bubblewrap runs a first-time wizard on any command until this file exists, which would
# stop every automated run dead. Writing it here means the container is ready on first use,
# and points it at the JDK and SDK installed above rather than downloading its own copies.
RUN mkdir -p /home/app/.bubblewrap \
    && printf '{\n  "jdkPath": "%s",\n  "androidSdkPath": "%s"\n}\n' \
    "${JAVA_HOME}" "${ANDROID_HOME}" > /home/app/.bubblewrap/config.json

# Created here, as `app`, because the compose file mounts a named volume over it: Docker seeds
# a fresh volume from the image path and copies its ownership, and a path that does not exist
# in the image gets a root-owned volume that Gradle then cannot write to.
RUN mkdir -p /home/app/.gradle

WORKDIR /work

# The node base image's entrypoint guesses: anything it does not recognise as a system command
# gets `node` put in front of it, so `docker compose run android ./gradlew assembleDebug` was
# handed to Node as a JS module ("Cannot find module '/work/gradlew'"). Nothing here is ever a
# script for Node to run — the commands are gradle, bubblewrap and bash — so the guessing is
# only ever wrong. Cleared, so `run` executes exactly what it is given.
ENTRYPOINT []

CMD ["sleep", "infinity"]
