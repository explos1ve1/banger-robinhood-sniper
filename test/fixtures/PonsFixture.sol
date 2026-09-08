// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// LOCAL TEST HARNESS ONLY. These permissive helpers are never mainnet routers.
import {PonsV2BondingCurve} from "pons/PonsV2BondingCurve.sol";
import {PonsV2MemeHook} from "pons/hooks/PonsV2MemeHook.sol";
import {PonsV2BuybackVault} from "pons/PonsV2BuybackVault.sol";
import {FeePolicySnapshot, IPonsV2FeeEscrow, IPonsV2FeePolicy, IPonsV2LaunchFactory, GraduationPhase} from "pons/interfaces/ILaunchpadV2.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ILiquidityFixture {
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes memory hookData) external payable returns (int256);
}
contract FixtureEscrow {
    function credit(address) external payable {}
}
contract FixtureCreate2 {
    function deploy(bytes32 salt, bytes memory initCode) external returns (address deployed) {
        assembly { deployed := create2(0, add(initCode, 32), mload(initCode), salt) }
        require(deployed != address(0), "create2 failed");
    }
}
contract FixtureCurve is PonsV2BondingCurve {
    uint256 public testSnipeTax;
    // The published base curve snapshot predates the opening-tax getter.
    // This shim tests read/gating behavior; trades are tested at zero opening tax.
    constructor(address parent, address quote, address hook, address escrow)
        PonsV2BondingCurve(quote, msg.sender, parent, IPonsV2FeePolicy(hook),
            FeePolicySnapshot(msg.sender, 3000, 0, 100, 300), IPonsV2FeeEscrow(escrow),
            PonsV2BuybackVault(escrow), 10 ether, 100, 200, false, 1 ether) {}
    function currentSnipeTaxBps(address) external view returns (uint256) { return testSnipeTax; }
    function setTestSnipeTax(uint256 value) external { testSnipeTax = value; }
}
contract FixtureFactory is IPonsV2LaunchFactory {
    address public immutable poolManager;
    address public immutable permit2;
    address public immutable memeHook;
    bool public allowGraduation;
    mapping(address => LaunchedToken) private records;
    event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold);
    constructor(address manager, address permit, address hook) { poolManager = manager; permit2 = permit; memeHook = hook; }
    function register(address token, address curve, address quote) external {
        PonsV2BondingCurve(curve).initialize(token);
        records[token] = LaunchedToken(token, curve, msg.sender, msg.sender, quote, 1 ether, 0, 60, 200, false, GraduationPhase.NotGraduated, 0, 0, 0, true);
        emit TokenLaunched(token, curve, msg.sender, quote, 0, 1 ether);
    }
    function getLaunchedToken(address token) external view returns (LaunchedToken memory) { return records[token]; }
    function setAllowGraduation(bool enabled) external { allowGraduation = enabled; }
    function graduate(address token) external {
        require(allowGraduation, "test graduation paused");
        (uint256 quote, uint256 amount) = PonsV2BondingCurve(records[token].curve).graduate(address(this));
        records[token].phase = GraduationPhase.Swept;
        records[token].sweptQuote = quote;
        records[token].sweptTokens = amount;
    }
    function seed(address token, address helper, uint160 sqrtPrice, int256 liquidity) external {
        LaunchedToken storage record = records[token];
        require(record.phase == GraduationPhase.Swept, "wrong phase");
        PoolKey memory key = PoolKey(Currency.wrap(address(0)), Currency.wrap(token), 0, 60, IHooks(memeHook));
        IPoolManager(poolManager).initialize(key, sqrtPrice);
        PonsV2MemeHook(payable(memeHook)).registerPool(key, token, record.deployer, record.deployer, 200, false,
            FeePolicySnapshot(record.deployer, 3000, 0, 100, 300));
        IERC20(token).approve(helper, record.sweptTokens);
        ILiquidityFixture(helper).modifyLiquidity{value: record.sweptQuote}(key,
            ModifyLiquidityParams(-887220, 887220, liquidity, bytes32(0)), "");
        record.phase = GraduationPhase.PoolCreated;
    }
    receive() external payable {}
}
