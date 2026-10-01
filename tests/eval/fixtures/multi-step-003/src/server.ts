export function handleRequest(ok: boolean): void {
  if (ok) {
    console.log("ok");
  } else {
    console.error("fail");
  }
}
