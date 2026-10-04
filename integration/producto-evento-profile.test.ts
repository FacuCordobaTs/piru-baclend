import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

// Los mocks de DB/auth afectan el cache global de Bun. Ejecutar el handler real en
// otro proceso preserva las assertions del perfil sin reemplazar la auth de otras suites.
test('profile conserva eventoSucursalId (handler y mocks aislados)', async () => {
  const fixture = fileURLToPath(
    new URL('./fixtures/producto-evento-profile.fixture.ts', import.meta.url),
  )
  const proceso = Bun.spawn([process.execPath, 'test', fixture], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [salida, errores, status] = await Promise.all([
    new Response(proceso.stdout).text(),
    new Response(proceso.stderr).text(),
    proceso.exited,
  ])
  expect(status, `${salida}\n${errores}`).toBe(0)
  expect(errores).toContain('1 pass')
})
