const { ethers } = require('ethers');

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_RPC_URL = `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;

const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);

const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)'
];

const usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);

/**
 * Fetch transaction and receipt from blockchain
 * @param {string} txHash - Transaction hash (0x...)
 * @returns {Object|null} { tx, receipt } or null if not found
 */
async function getTransaction(txHash) {
  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx) return null;

    const receipt = await provider.getTransactionReceipt(txHash);
    return { tx, receipt };
  } catch (error) {
    console.error('Error fetching transaction:', error.message);
    return null;
  }
}

/**
 * Verify USDC payment transaction on Base network
 * @param {string} txHash - Transaction hash to verify
 * @param {number} expectedAmountUSDC - Expected payment amount in USDC
 * @param {string} recipientAddress - Expected recipient wallet address
 * @returns {Object} { valid: boolean, error?: string, amount?: number, from?: string, to?: string, blockNumber?: number }
 */
async function verifyUSDCPayment(txHash, expectedAmountUSDC, recipientAddress) {
  const result = await getTransaction(txHash);
  if (!result) {
    return { valid: false, error: 'Transaction not found on blockchain' };
  }

  const { tx, receipt } = result;

  // 1. Check transaction succeeded (status = 1)
  if (receipt.status !== 1) {
    return { valid: false, error: 'Transaction failed (reverted on-chain)' };
  }

  // 2. Check transaction is to USDC contract
  if (tx.to.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
    return {
      valid: false,
      error: `Transaction not to USDC contract (sent to ${tx.to})`
    };
  }

  // 3. Decode transfer data
  const iface = new ethers.Interface(USDC_ABI);
  let decodedData;
  try {
    decodedData = iface.parseTransaction({ data: tx.data });
  } catch (e) {
    return { valid: false, error: 'Could not decode transaction data' };
  }

  if (decodedData.name !== 'transfer') {
    return {
      valid: false,
      error: `Transaction is not a transfer (method: ${decodedData.name})`
    };
  }

  const [to, amount] = decodedData.args;

  // 4. Check recipient matches expected address
  if (to.toLowerCase() !== recipientAddress.toLowerCase()) {
    return {
      valid: false,
      error: `Payment sent to wrong address: expected ${recipientAddress}, got ${to}`
    };
  }

  // 5. Check amount (USDC has 6 decimals)
  const amountUSDC = Number(amount) / 1e6;
  const expectedAmount = Number(expectedAmountUSDC);

  // Allow 0.1% tolerance for rounding errors
  const tolerance = expectedAmount * 0.001;
  if (Math.abs(amountUSDC - expectedAmount) > tolerance) {
    return {
      valid: false,
      error: `Amount mismatch: expected ${expectedAmount} USDC, got ${amountUSDC} USDC`
    };
  }

  return {
    valid: true,
    amount: amountUSDC,
    from: tx.from,
    to,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash
  };
}

/**
 * Get USDC balance for an address
 * @param {string} address - Ethereum address
 * @returns {number|null} Balance in USDC or null if error
 */
async function getUSDCBalance(address) {
  try {
    const balance = await usdcContract.balanceOf(address);
    const decimals = await usdcContract.decimals();
    return Number(balance) / 10**Number(decimals);
  } catch (error) {
    console.error('Error fetching USDC balance:', error.message);
    return null;
  }
}

module.exports = {
  getTransaction,
  verifyUSDCPayment,
  getUSDCBalance,
  USDC_ADDRESS
};
