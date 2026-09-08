// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Local-test tokens only. The public mint deliberately funds isolated test pools.
// These contracts are never deployed by the production bot.
contract TestToken {
    string public name; string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from,address indexed to,uint256 value);
    event Approval(address indexed owner,address indexed spender,uint256 value);
    constructor(string memory n,string memory s){name=n;symbol=s;}
    function mint(address to,uint256 amount) external {totalSupply+=amount;balanceOf[to]+=amount;emit Transfer(address(0),to,amount);}
    function approve(address spender,uint256 amount) external returns(bool){allowance[msg.sender][spender]=amount;emit Approval(msg.sender,spender,amount);return true;}
    function transfer(address to,uint256 amount) external returns(bool){_transfer(msg.sender,to,amount);return true;}
    function transferFrom(address from,address to,uint256 amount) external returns(bool){
        if(allowance[from][msg.sender]!=type(uint256).max)allowance[from][msg.sender]-=amount;
        _transfer(from,to,amount);return true;
    }
    function _transfer(address from,address to,uint256 amount) internal {balanceOf[from]-=amount;balanceOf[to]+=amount;emit Transfer(from,to,amount);}
}
contract TestWETH is TestToken {
    event Deposit(address indexed dst,uint256 wad);
    event Withdrawal(address indexed src,uint256 wad);
    constructor() TestToken("Wrapped Ether","WETH"){}
    receive() external payable {deposit();}
    function deposit() public payable {totalSupply+=msg.value;balanceOf[msg.sender]+=msg.value;emit Deposit(msg.sender,msg.value);emit Transfer(address(0),msg.sender,msg.value);}
    function withdraw(uint256 wad) external {balanceOf[msg.sender]-=wad;totalSupply-=wad;emit Transfer(msg.sender,address(0),wad);emit Withdrawal(msg.sender,wad);(bool ok,)=msg.sender.call{value:wad}("");require(ok);}
}
