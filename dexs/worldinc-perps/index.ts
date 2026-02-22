import { FetchOptions, FetchResultVolume, SimpleAdapter } from "../../adapters/types";
import { CHAIN } from "../../helpers/chains";

// Composite Exchange contract address
const COMPOSITE_EXCHANGE = "0x5e3Ae52EbA0F9740364Bd5dd39738e1336086A8b";

// Composite exchange deployment block; clamp trade log range so we never request blocks before the exchange existed
const EXCHANGE_START_BLOCK = 7274994;

// Event signatures for perp orderbook registration and trades
const SPOT_PERP_TRADE_EVENT = "event NewTrade(uint64 indexed buyer, uint64 indexed seller, uint256 spotMatchQuantities, uint256 spotMatchData)";

// Helper function to parse spot match quantities
function parseSpotMatchQuantities(smq: bigint) {
  const MASK_64 = BigInt("0xFFFFFFFFFFFFFFFF");
  const fromFee = smq & MASK_64;
  const toFee = (smq >> 64n) & MASK_64;
  const fromQuantity = (smq >> 128n) & MASK_64;
  const toQuantity = (smq >> 192n) & MASK_64;
  return { fromFee, toFee, fromQuantity, toQuantity };
}

/** Convert position-denominated raw amount to ERC20 raw (smallest unit). */
function positionRawToErc20Raw(raw: bigint, positionDecimals: number, erc20Decimals: number): bigint {
  if (positionDecimals === erc20Decimals) return raw;
  if (erc20Decimals >= positionDecimals) return raw * 10n ** BigInt(erc20Decimals - positionDecimals);
  return raw / 10n ** BigInt(positionDecimals - erc20Decimals);
}

// Helper function to decode token config
function decodeVaultTokenConfig(vtc: bigint) {
  const vtcBigInt = BigInt(vtc);
  const addressMask = (1n << 160n) - 1n;
  const tokenAddressRaw = vtcBigInt & addressMask;
  const tokenAddress = "0x" + tokenAddressRaw.toString(16).padStart(40, "0");

  const sequestrationMultiplier = Number((vtcBigInt >> 160n) & 0xffn);
  const positionDecimals = Number((vtcBigInt >> 168n) & 0xffn);
  const vaultDecimals = Number((vtcBigInt >> 176n) & 0xffn);
  const erc20Decimals = Number((vtcBigInt >> 184n) & 0xffn);
  const tokenType = Number((vtcBigInt >> 192n) & 0xffn);
  const tokenId = Number((vtcBigInt >> 200n) & 0xffffffffn);

  return {
    tokenAddress,
    sequestrationMultiplier,
    positionDecimals,
    vaultDecimals,
    erc20Decimals,
    tokenType,
    tokenId,
  };
}

// Discover perp orderbooks via contract view getPerpOrderBook(token1, token2)
async function getPerpOrderbooks(
  _getLogs: any,
  api: any,
  exchangeAddress: string
): Promise<{
  orderbooks: string[];
  tokenDecimals: Record<number, number>;
  tokenErc20Decimals: Record<number, number>;
  tokenAddresses: Record<number, string>;
  orderbookConfigs: Record<string, { baseId?: number; quoteId?: number; type: string }>;
}> {
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
  const highestTokenId = await api.call({
    abi: "function getHighestTokenId() external view returns (uint32)",
    target: exchangeAddress,
  });
  const maxId = Number(highestTokenId);

  const perpCalls: Array<{ target: string; params: [number, number] }> = [];
  for (let token1 = 1; token1 <= maxId; token1++) {
    for (let token2 = 1; token2 <= maxId; token2++) {
      if (token1 === token2) continue;
      perpCalls.push({ target: exchangeAddress, params: [token1, token2] });
    }
  }

  const perpResults = await api.multiCall({
    abi: "function getPerpOrderBook(uint32 token1, uint32 token2) external view returns (address, uint32 buyToken, uint32 payToken)",
    calls: perpCalls,
    permitFailure: true,
  });

  const orderbooks = new Set<string>();
  const orderbookConfigs: Record<string, { baseId?: number; quoteId?: number; type: string }> = {};
  const tokenIds = new Set<number>();

  perpResults.forEach((result: any, index: number) => {
    if (!result || result[0] == null) return;
    const addr = String(result[0]).toLowerCase();
    if (addr === ZERO_ADDRESS || addr === "0x") return;
    const buyToken = Number(result[1]);
    const payToken = Number(result[2]);
    orderbooks.add(addr);
    orderbookConfigs[addr] = { baseId: buyToken, quoteId: payToken, type: "PERP" };
    tokenIds.add(buyToken);
    tokenIds.add(payToken);
  });

  const finalOrderbooks = Array.from(orderbooks);
  const tokenDecimals: Record<number, number> = {};
  const tokenErc20Decimals: Record<number, number> = {};
  const tokenAddresses: Record<number, string> = {};

  const tokenConfigCalls = Array.from(tokenIds).map((tokenId) => ({
    target: exchangeAddress,
    params: [tokenId],
  }));

  const tokenConfigs = await api.multiCall({
    abi: "function readTokenConfig(uint32 tokenId) external view returns (uint256)",
    calls: tokenConfigCalls,
    permitFailure: true,
  });

  Array.from(tokenIds).forEach((tokenId, index) => {
    if (tokenConfigs[index] && tokenConfigs[index] !== 0n) {
      const config = decodeVaultTokenConfig(BigInt(tokenConfigs[index]));
      tokenDecimals[tokenId] = config.positionDecimals;
      tokenErc20Decimals[tokenId] = config.erc20Decimals || config.positionDecimals;
      if (config.tokenAddress && config.tokenAddress !== ZERO_ADDRESS) tokenAddresses[tokenId] = config.tokenAddress;
    } else {
      tokenDecimals[tokenId] = 8;
      tokenErc20Decimals[tokenId] = 8;
    }
  });

  return { orderbooks: finalOrderbooks, tokenDecimals, tokenErc20Decimals, tokenAddresses, orderbookConfigs };
}

const ZERO = "0x0000000000000000000000000000000000000000";

const fetch = async (options: FetchOptions): Promise<FetchResultVolume> => {
  const { getLogs, api, getFromBlock, getToBlock, createBalances } = options;
  const dailyVolume = createBalances();

  let orderbookData: Awaited<ReturnType<typeof getPerpOrderbooks>> | null = null;
  try {
    orderbookData = await getPerpOrderbooks(getLogs, api, COMPOSITE_EXCHANGE);
  } catch (e) {
    return { dailyVolume };
  }

  const { orderbooks: orderbookAddresses, tokenDecimals, tokenErc20Decimals, tokenAddresses, orderbookConfigs } = orderbookData;

  if (orderbookAddresses.length === 0) {
    return { dailyVolume };
  }

  let fromBlock = await getFromBlock();
  const toBlock = await getToBlock();
  if (fromBlock == null || toBlock == null) {
    return { dailyVolume };
  }
  fromBlock = Math.max(fromBlock, EXCHANGE_START_BLOCK);

  try {
    const perpLogs = await getLogs({
      targets: orderbookAddresses,
      eventAbi: SPOT_PERP_TRADE_EVENT,
      entireLog: true,
      fromBlock,
      toBlock,
      cacheInCloud: false,
      skipIndexer: true,
    });

    const volumeByTokenIdRaw: Record<number, bigint> = {};
    function addVolumeRaw(tokenId: number, rawErc20: bigint) {
      if (!volumeByTokenIdRaw[tokenId]) volumeByTokenIdRaw[tokenId] = 0n;
      volumeByTokenIdRaw[tokenId] += rawErc20;
    }

    // One leg pays base (fromQuantity), one pays quote (toQuantity); different assets, not double-counting.
    for (const log of perpLogs as any[]) {
      const eventData = log.args || log.parsedLog?.args || log;
      if (!eventData.spotMatchQuantities) continue;

      const orderbookAddr = (log.address || log.srcAddress || log.target)?.toLowerCase();
      const config = orderbookConfigs[orderbookAddr];
      if (!config?.baseId || !config?.quoteId) continue;

      const qty = parseSpotMatchQuantities(BigInt(eventData.spotMatchQuantities));
      const basePosD = tokenDecimals[config.baseId] ?? 8;
      const quotePosD = tokenDecimals[config.quoteId] ?? 8;
      const baseErc = tokenErc20Decimals[config.baseId] ?? basePosD;
      const quoteErc = tokenErc20Decimals[config.quoteId] ?? quotePosD;

      if (qty.fromQuantity > 0n) {
        addVolumeRaw(config.baseId, positionRawToErc20Raw(qty.fromQuantity, basePosD, baseErc));
      }
      if (qty.toQuantity > 0n) {
        addVolumeRaw(config.quoteId, positionRawToErc20Raw(qty.toQuantity, quotePosD, quoteErc));
      }
    }

    for (const [tokenIdStr, raw] of Object.entries(volumeByTokenIdRaw)) {
      const tokenId = Number(tokenIdStr);
      const addr = tokenAddresses[tokenId];
      if (!addr || addr === ZERO || raw === 0n) continue;
      dailyVolume.add(addr, raw);
    }

    return { dailyVolume };
  } catch (e) {
    return { dailyVolume };
  }
};

const adapter: SimpleAdapter = {
  version: 2,
  fetch,
  chains: [CHAIN.MEGAETH],
  start: "2026-02-01",
};

export default adapter;
