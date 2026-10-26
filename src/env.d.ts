declare const process: {
  readonly env: {
    /** 浏览器里开发时连的本机服务地址，不填是 http://127.0.0.1:4865 */
    readonly EXPO_PUBLIC_SERVER_BASE_URL?: string;
  };
};
