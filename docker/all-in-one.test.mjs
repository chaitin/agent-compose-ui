import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('all-in-one image embeds and imports the bundled sandbox image', async () => {
  const [dockerfile, prepare] = await Promise.all([
    read('./Dockerfile.all-in-one'),
    read('./all-in-one/s6/prepare/up'),
  ]);
  assert.match(dockerfile, /FROM \$\{GUEST_IMAGE\} AS guest-rootfs/);
  assert.match(dockerfile, /agent-compose-guest\.rootfs\.tar\.xz/);
  assert.match(dockerfile, /FROM .* AS engine-binary-build/);
  assert.match(dockerfile, /COPY --from=engine-binary-build \/out\/agent-compose \/app\/agent-compose/);
  assert.match(dockerfile, /agent-compose-migrate/);
  assert.match(prepare, /docker import/);
  assert.match(prepare, /BUNDLED_GUEST_IMAGE/);
});

test('single container receives the frontend and backend storage topology', async () => {
  const [compose, dockerfile, prepare] = await Promise.all([
    read('./docker-compose.all-in-one.yml'),
    read('./Dockerfile.all-in-one'),
    read('./all-in-one/s6/prepare/up'),
  ]);
  assert.match(compose, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
  assert.match(compose, /AGENT_COMPOSE_DB_PATH: \/data\/data\.db/);
  for (const variable of [
    'AGENT_COMPOSE_URL',
    'SCRIPT_SERVICE_URL',
    'SCRIPT_SERVICE_TOKEN',
    'PROJECT_STORAGE_ROOT',
    'DEFAULT_IMAGE',
    'DOCKER_DEFAULT_IMAGE',
    'CAP_GRPC_TARGET',
  ]) {
    assert.match(`${compose}\n${dockerfile}\n${prepare}`, new RegExp(variable));
  }
});
