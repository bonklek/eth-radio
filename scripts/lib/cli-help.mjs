export function helpRequested(argv = process.argv.slice(2)) {
  return argv.includes('--help') || argv.includes('-h')
}
