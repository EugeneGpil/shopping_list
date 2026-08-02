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
set('keep_releases', 3);

set('artifact', 'build/release.tar.gz');

set('shared_files', [
    '.env',       // docker compose: ports, DB credentials, COMPOSE_PROJECT_NAME
    'back/.env',  // Laravel production config
]);

set('shared_dirs', [
    'back/storage',                 // logs, caches, and app/firebase-credentials.json
    'docker/volumes/postgres_data', // the database — must never live inside a release
    'docker/volumes/php_home',
]);

// Shared dirs are already owned by the deploy user; skip the ACL/chmod pass.
set('writable_dirs', []);

/**
 * `node` is deliberately absent: the front is a static build, and pulling the
 * node image would cost disk this box does not have.
 */
set('compose_services', 'nginx php postgres mailpit');

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
    // paths changed (nginx, php); postgres and mailpit keep running.
    //
    // Never use `docker compose down` here: it stops the database and tears
    // down the network. COMPOSE_PROJECT_NAME in the shared .env is what keeps
    // container and network names stable across release directories — without
    // it, every release would get its own project and its own empty database.
    run('cd {{release_path}} && docker compose up -d {{compose_services}}');
});

desc('Verify the shipped vendor matches the runtime PHP');
task('deploy:check_platform', function () {
    // vendor/ is built in CI inside this same image, so this should never fail
    // — which is exactly why it is worth asserting. Catches an image rebuilt
    // without an extension, or a vendor built somewhere else by hand.
    run('cd {{release_path}} && docker compose exec -T -e HOME=/tmp php composer check-platform-reqs --no-dev');
});

desc('Run database migrations');
task('deploy:migrate', function () {
    run('cd {{release_path}} && {{artisan}} migrate --force');
});

desc('Cache Laravel config and routes');
task('deploy:optimize', function () {
    run('cd {{release_path}} && {{artisan}} config:cache');
    run('cd {{release_path}} && {{artisan}} route:cache');
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

// Rollback repoints `current`; the containers still run the failed release
// until compose is re-run against the restored one.
desc('Restart containers from the rolled-back release');
task('rollback:compose', function () {
    run('cd {{deploy_path}}/current && docker compose up -d {{compose_services}}');
});
after('rollback', 'rollback:compose');
