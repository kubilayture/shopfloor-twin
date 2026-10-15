import { execFileSync } from 'node:child_process';

/**
 * Testcontainers looks for Docker at the default socket. Docker Desktop alternatives such as Colima
 * use another one, so without DOCKER_HOST the active `docker context` decides, as for the CLI.
 * Call before starting a container.
 */
export function useDockerContext(): void {
  if (process.env.DOCKER_HOST) return;
  try {
    const host = execFileSync(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      { encoding: 'utf8' },
    ).trim();
    if (host.startsWith('unix://') && host !== 'unix:///var/run/docker.sock') {
      process.env.DOCKER_HOST = host;
      // A VM-based runtime (Colima, Docker Desktop) has the usual socket inside the VM, which the
      // Ryuk reaper mounts. Rootless Docker (/run/user/…) is left to Testcontainers' own detection.
      if (!host.startsWith('unix:///run/user/')) {
        process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ??= '/var/run/docker.sock';
      }
    }
  } catch {
    // No docker CLI: let Testcontainers try its defaults.
  }
}
