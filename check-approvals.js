const { ethers } = require('ethers');
const dotenv = require('dotenv');

dotenv.config();

// --- CONFIGURATION ---
const RPC_URL = 'https://polygon-bor-rpc.publicnode.com'; // Use HTTP for this, not WS
const PRIVATE_KEY = process.env.PHANTOM_POLYGON_WALLET_PRIVATE_KEY;
const PROXY_ADDRESS = '0x2ddc093099a5722dc017c70e756dd3ea5586951e'; // Your Proxy
const USDC_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';

// Spenders that need approval
const SPENDERS = [
    { name: "Legacy Exchange", address: '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e' },
    { name: "NegRisk Exchange", address: '0xC5d563A36AE78145C45a50134d48A1215220f80a' }
];

// ABIs
const USDC_ABI = [
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)"
];
const PROXY_ABI = [
    { "inputs": [{ "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "value", "type": "uint256" }, { "internalType": "bytes", "name": "data", "type": "bytes" }, { "internalType": "enum Enum.Operation", "name": "operation", "type": "uint8" }, { "internalType": "uint256", "name": "safeTxGas", "type": "uint256" }, { "internalType": "uint256", "name": "baseGas", "type": "uint256" }, { "internalType": "uint256", "name": "gasPrice", "type": "uint256" }, { "internalType": "address", "name": "gasToken", "type": "address" }, { "internalType": "address payable", "name": "refundReceiver", "type": "address" }, { "internalType": "bytes", "name": "signatures", "type": "bytes" }], "name": "execTransaction", "outputs": [{ "internalType": "bool", "name": "success", "type": "bool" }], "stateMutability": "payable", "type": "function" }
];

async function checkAndApprove() {
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const signer = new ethers.Wallet(PRIVATE_KEY, provider);
    const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
    const proxy = new ethers.Contract(PROXY_ADDRESS, PROXY_ABI, signer);

    console.log(`Checking approvals for Proxy: ${PROXY_ADDRESS}`);

    for (const spender of SPENDERS) {
        const allowance = await usdc.allowance(PROXY_ADDRESS, spender.address);
        const formatted = ethers.utils.formatUnits(allowance, 6);

        console.log(`[${spender.name}] Allowance: $${formatted}`);

        if (parseFloat(formatted) < 10000) {
            console.log(`>>> APPROVING ${spender.name}...`);

            // 1. Create the Inner Transaction (USDC.approve)
            const innerData = usdc.interface.encodeFunctionData("approve", [
                spender.address,
                ethers.constants.MaxUint256
            ]);

            // 2. Sign the Proxy Transaction
            const signature = ethers.utils.solidityPack(
                ["uint256", "uint256", "uint8"],
                [signer.address, 0, 1] // r, s, v for "Approved by owner"
            );

            // 3. Execute via Proxy
            try {
                const tx = await proxy.execTransaction(
                    USDC_ADDRESS, // To: USDC Contract
                    0,            // Value: 0 ETH
                    innerData,    // Data: approve(...)
                    0,            // Operation: Call
                    0, 0, 0,      // Gas settings (safe defaults)
                    ethers.constants.AddressZero,
                    ethers.constants.AddressZero,
                    signature,
                    { gasLimit: 200000 } // Add gas buffer
                );
                console.log(`   Tx Hash: ${tx.hash}`);
                await tx.wait();
                console.log(`   Success! Approved.`);
            } catch (e) {
                console.error(`   Failed to approve: ${e.message}`);
            }
        } else {
            console.log(`   ✅ Already Approved.`);
        }
    }
}

checkAndApprove();