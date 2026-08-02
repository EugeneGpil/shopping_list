<?php

/**
 * Deployer configuration — https://deployer.org
 *
 * The release artifact is built in GitHub Actions (composer install + the
 * Quasar PWA build) and uploaded here ready to run. Nothing is compiled on the
 * VPS.
 *
 * Layout under DEPLOY_PATH on the server:
 *
 *   <DEPLOY_PATH>/
 *   ├── releases/<n>/     code + back/vendor + front/dist/pwa
 *   ├── shared/           .env files, Laravel storage, postgres data
 *   └── current -> releases/<n>
 *
 * Note that host nginx never reads these paths — it only proxies to
 * 127.0.0.1:8000 and :8080 — so no nginx config depends on `current`.
 */

namespace Deployer;

require 'recipe/common.php';

set('application', 'shopping_list');
set('keep_releases', 2);   // current + one to roll back to; each release is ~100 MB

set('artifact', 'build/release.tar.gz');

set('shared_files', ['.env']);
set('shared_dirs', []);

// Shared dirs are already owned by the deploy user; skip the ACL/chmod pass.
set('writable_dirs', []);

set('compose_services', 'nginx php postgres');

/**
 * One definition, used by both the deploy and the recovery path — they must not
 * drift.
 *
 * --build keeps the server's php image in step with that release's
 * docker/php/Dockerfile: CI's image never reaches the server, since there is no
 * registry between them.
 *
 * Usually free — an unchanged base and Dockerfile is a pure cache hit, 0.2 s on
 * the VPS. But the base images use floating tags, and BuildKit re-resolves them
 * at build time, so an upstream republish of php:8.4-fpm-bookworm silently
 * invalidates the FROM layer and this recompiles gd, intl and the rest: about
 * 4 minutes on 1 vCPU. That is what the timeout below is for — Deployer's 300 s
 * default would kill such a build partway through.
 */
set('compose_up', 'docker compose up -d --build {{compose_services}}');
set('compose_timeout', 1800);

// Probed after the containers come up, so it exercises the whole path: host
// nginx, TLS, the front container and Laravel. The full URL lives in the
// environment rather than being assembled here, so moving the endpoint is a
// config change, not a code change. Kept out of the repo like DEPLOY_HOST.
$healthcheckUrl = getenv('HEALTHCHECK_URL');

if (! $healthcheckUrl) {
    throw new \RuntimeException(
        'HEALTHCHECK_URL is not set. Export the full health endpoint before running dep, '
        . 'e.g. HEALTHCHECK_URL=https://app.example.com/api/health dep deploy production'
    );
}

set('health_url', $healthcheckUrl);

// Runs artisan in the php container. HOME=/tmp keeps psysh and friends from
// complaining that they cannot write to the container user's home.
set('artisan', 'docker compose exec -T -e HOME=/tmp php php artisan');

// The server address is not stored in the repo. CI passes it from the
// DEPLOY_HOST secret; for a local `dep deploy production`, export it first.
$deployHost = getenv('DEPLOY_HOST');

if (! $deployHost) {
    throw new \RuntimeException(
        'DEPLOY_HOST is not set. Export the server hostname or IP before running dep, '
        . 'e.g. DEPLOY_HOST=203.0.113.10 dep deploy production'
    );
}

$deployUser = getenv('DEPLOY_USER');

if (! $deployUser) {
    throw new \RuntimeException(
        'DEPLOY_USER is not set. Export the SSH user before running dep, '
        . 'e.g. DEPLOY_USER=deploy dep deploy production'
    );
}

$deployPath = getenv('DEPLOY_PATH');

if (! $deployPath) {
    throw new \RuntimeException(
        'DEPLOY_PATH is not set. Export the deploy directory before running dep, '
        . 'e.g. DEPLOY_PATH=~/www/myapp dep deploy production'
    );
}

host('production')
    ->setHostname($deployHost)
    ->setRemoteUser($deployUser)
    ->setDeployPath($deployPath);

/* -------------------------------------------------------------------------
 * Artifact upload, replacing the default git clone
 * ---------------------------------------------------------------------- */

desc('Upload and unpack the CI-built artifact');
task('deploy:update_code', function () {
    upload(get('artifact'), '{{release_path}}/release.tar.gz');
    run('cd {{release_path}} && tar -xzf release.tar.gz && rm release.tar.gz');
});

/* -------------------------------------------------------------------------
 * Docker
 * ---------------------------------------------------------------------- */

desc('Start the new release containers');
task('deploy:compose', function () {
    // Compose diffs the config and recreates only the services whose bind-mount
    // paths changed — nginx and php. postgres keeps running, because its data
    // path comes from POSTGRES_DATA and so is identical across releases.
    //
    // Never use `docker compose down` here: it stops the database and tears
    // down the network. COMPOSE_PROJECT_NAME in the shared .env is what keeps
    // container and network names stable across release directories — without
    // it, every release would get its own project and its own empty database.
    run('cd {{release_path}} && {{compose_up}}', timeout: (int) get('compose_timeout'));
});

desc('Verify the shipped vendor matches the runtime PHP');
task('deploy:check_platform', function () {
    // Not redundant with building vendor/ in a container: CI and the server
    // build the php image *separately* from the same Dockerfile — there is no
    // registry between them — so the server can be running an older image than
    // the one vendor was resolved against. Add an extension to the Dockerfile,
    // skip the manual rebuild on the server, and this is what turns a runtime
    // 500 into a deploy that stops and names the missing extension. ~1 second.
    run('cd {{release_path}} && docker compose exec -T -e HOME=/tmp php composer check-platform-reqs --no-dev');
});

desc('Run database migrations');
task('deploy:migrate', function () {
    run('cd {{release_path}} && {{artisan}} migrate --force');
});

desc('Build Laravel bootstrap caches');
task('deploy:optimize', function () {
    run('cd {{release_path}} && {{artisan}} optimize');
});

desc('Verify the deployed app answers');
task('deploy:health', function () {
    run('curl -fsS --max-time 15 -o /dev/null {{health_url}}');
});

/* -------------------------------------------------------------------------
 * Flow
 * ---------------------------------------------------------------------- */

desc('Deploy the application');
task('deploy', [
    'deploy:prepare',   // info, setup, lock, release, update_code, shared, writable
    'deploy:compose',
    'deploy:check_platform',
    'deploy:migrate',
    'deploy:optimize',
    'deploy:health',
    'deploy:publish',   // symlink, unlock, cleanup, success
]);

after('deploy:failed', 'deploy:unlock');

/**
 * Point the running containers at whatever `current` is.
 *
 * Needed after both of the ways a release can change without compose noticing:
 *
 *   deploy failure — deploy:compose is the real cutover and runs before
 *     deploy:publish, so a failure in check_platform/migrate/optimize/health
 *     leaves the containers serving the broken release while `current` still
 *     points at the last good one. Running this reverts what is being served.
 *     (`dep rollback` is the wrong tool for that case: it would move `current`
 *     one release further back, since the failed deploy never advanced it.)
 *
 *   manual rollback — `dep rollback` repoints `current` but never touches the
 *     containers, so without this it looks successful while the old release
 *     keeps serving.
 *
 * The guard covers the first-ever deploy, when no `current` exists yet.
 */
desc('Bring the containers up on whatever `current` points at');
task('compose:current', function () {
    if (test('[ -L {{deploy_path}}/current ]')) {
        run('cd {{deploy_path}}/current && {{compose_up}}', timeout: (int) get('compose_timeout'));
    } else {
        writeln('No previous release to fall back to — leaving containers as they are.');
    }
});

after('deploy:failed', 'compose:current');
after('rollback', 'compose:current');
