/** The part of a browser WebSocket the SDK uses, driven by the test. */
export class FakeSocket extends EventTarget {
  readonly sent: unknown[] = [];
  closedWith: number | undefined;
  readonly url: URL;

  constructor(url: URL) {
    super();
    this.url = url;
  }

  send(text: string) {
    this.sent.push(JSON.parse(text));
  }

  close(code: number) {
    this.closedWith = code;
  }

  open() {
    this.dispatchEvent(new Event('open'));
  }

  receive(data: object | string | ArrayBuffer) {
    const frame =
      typeof data === 'object' && !(data instanceof ArrayBuffer) ? JSON.stringify(data) : data;
    this.dispatchEvent(new MessageEvent('message', { data: frame }));
  }

  drop(code: number) {
    this.dispatchEvent(new CloseEvent('close', { code }));
  }
}
