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

    uint256 public fee;
    bool public laneClosed;

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
        return keccak256(abi.encode(destSelector, msg.sender, block.number));
    }
}
