// Catches JS errors and unhandled promise rejections that React's own error
// boundaries don't (React only wraps render/lifecycle -- an error thrown
// from an event handler, timer, or floating promise otherwise vanishes with
// nothing but a console line no one packaged with the app will ever see) and
// forwards them to the main process to append to a local log file. Nothing
// is sent anywhere off the device -- see diagnosticsAPI.openLogsFolder in
// Settings for how a user can find and share that file themselves.
export function armRendererDiagnostics() {
  window.addEventListener('error', (event) => {
    window.diagnosticsAPI?.reportRendererError({
      kind: 'window.onerror',
      message: event.error instanceof Error ? event.error.message : event.message,
      stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    window.diagnosticsAPI?.reportRendererError({
      kind: 'unhandledrejection',
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}
