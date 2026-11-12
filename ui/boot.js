// BOOT
// =====================================================================
foldMount();
armArchitect();
go(location.hash.slice(1) || "chat");
connState(null);
ping().catch(() => {});
setInterval(() => { if (!document.hidden && current !== "lanes") ping().catch(() => {}); }, 60_000);
req("/v1/models").then((d) => { catalog = d.data ?? []; renderModelList(catalog); updateModelHint(); }).catch(() => {});
restoreConvFromServer();
