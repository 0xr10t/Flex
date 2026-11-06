// SPDX-License-Identifier: MIT
// Test-only stand-ins, never deployed to a public chain. Their code is placed at the real registered addresses on a local
// chain, so the wallet runs with its production constants.
pragma solidity ^0.8.24;

/// USDC stand-in with 6 decimals.
contract MockUSDC {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// Plays the CRE KeystoneForwarder: calls onReport with metadata = (workflowId, name, owner). Doesn't check DON signatures.
contract MockForwarder {
    function deliver(address receiver, bytes32 workflowId, bytes10 name, address owner, bytes calldata report) external {
        bytes memory metadata = abi.encodePacked(workflowId, name, owner);
        (bool ok, bytes memory ret) = receiver.call(abi.encodeWithSignature("onReport(bytes,bytes)", metadata, report));
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}

/// CCIP router stand-in, with the send-time rules found in the lab: an underpaid fee reverts, an overpaid fee is kept, and
/// the token moves by transferFrom. It delivers nothing; a test mints on the destination chain to play the network.
contract MockCcipRouter {
    struct Receipt { address issuer; uint32 destGasLimit; uint32 destBytesOverhead; uint256 feeTokenAmount; bytes extraArgs; }
    struct TokenAmount {
        address token;
        uint256 amount;
    }
    struct Message {
        bytes receiver;
        bytes data;
        TokenAmount[] tokenAmounts;
        address feeToken;
        bytes extraArgs;
    }

    event Sent(uint64 indexed destSelector, address indexed receiver, address token, uint256 amount, uint256 feePaid);
    event CCIPMessageSent(uint64 indexed destChainSelector, address indexed sender, bytes32 indexed messageId,
        address feeToken, uint256 tokenAmountBeforeTokenPoolFees, bytes encodedMessage, Receipt[] receipts, bytes[] verifierBlobs);
    event ExecutionStateChanged(uint64 indexed sourceChainSelector, uint64 indexed messageNumber,
        bytes32 indexed messageId, uint8 state, bytes returnData);

    uint256 public fee;
    bool public laneClosed;
    uint64 public sourceSelector;
    uint64 public messageNumber;
    mapping(uint64 => address) public remoteTokens;
    mapping(uint64 => address) public remoteRamps;

    function configure(uint64 source, uint64 dest, address token, address ramp) external {
        sourceSelector = source;
        remoteTokens[dest] = token;
        remoteRamps[dest] = ramp;
    }
    function getOnRamp(uint64) external view returns (address) { return address(this); }
    function isOffRamp(uint64, address ramp) external view returns (bool) { return ramp == address(this); }
    function typeAndVersion() external pure returns (string memory) { return "OnRamp 2.0.0"; }

    function deliver(uint64 source, uint64 number, bytes32 id, address token, address receiver, uint256 amount, bool success) external {
        if (success) MockUSDC(token).mint(receiver, amount);
        emit ExecutionStateChanged(source, number, id, success ? 2 : 3, success ? bytes("") : bytes("failed"));
    }

    function encodeMessage(uint64 dest, Message calldata message) private returns (bytes memory) {
        address receiver = abi.decode(message.receiver, (address));
        bytes memory token = abi.encodePacked(uint8(1), message.tokenAmounts[0].amount,
            uint8(20), address(this), uint8(20), message.tokenAmounts[0].token,
            uint8(20), remoteTokens[dest], uint8(20), receiver, uint16(0));
        bytes memory header = abi.encodePacked(uint8(1), sourceSelector, dest, ++messageNumber,
            uint32(500000), uint32(0), uint32(0), bytes32(0));
        bytes memory addresses = abi.encodePacked(uint8(20), address(this), uint8(20), remoteRamps[dest],
            uint8(20), msg.sender, uint8(20), receiver);
        return bytes.concat(header, addresses, abi.encodePacked(uint16(0), uint16(token.length), token, uint16(0)));
    }

    function setFee(uint256 value) external {
        fee = value;
    }

    function setLaneClosed(bool value) external {
        laneClosed = value;
    }

    function isChainSupported(uint64) external view returns (bool) {
        return !laneClosed;
    }

    function getFee(uint64, Message calldata) external view returns (uint256) {
        require(!laneClosed, "lane");
        return fee;
    }

    function ccipSend(uint64 destSelector, Message calldata message) external payable returns (bytes32) {
        require(!laneClosed, "lane");
        require(msg.value >= fee, "fee");
        require(message.tokenAmounts.length == 1, "one token");
        TokenAmount calldata t = message.tokenAmounts[0];
        (bool ok, bytes memory ret) = t.token.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), t.amount)
        );
        require(ok && abi.decode(ret, (bool)), "transfer");
        emit Sent(destSelector, abi.decode(message.receiver, (address)), t.token, t.amount, msg.value);
        bytes memory encoded = encodeMessage(destSelector, message);
        bytes32 id = keccak256(encoded);
        emit CCIPMessageSent(destSelector, msg.sender, id, address(0), t.amount, encoded, new Receipt[](0), new bytes[](0));
        return id;
    }
}
