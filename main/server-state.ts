import os from 'os';

const DEFAULT_PORT = parseInt(process.env.PORT || '3001', 10);
let activePort = DEFAULT_PORT;

export function getServerPort(): number {
  return activePort;
}

export function setServerPort(port: number): void {
  activePort = port;
}

/** Helper to check if an IPv4 address is active and valid (excludes loopback & 169.254.x.x link-local APIPA). */
function isValidLocalIPv4(alias: os.NetworkInterfaceInfo): boolean {
  const isIPv4 = alias.family === 'IPv4' || (alias.family as string | number) === 4;
  if (!isIPv4 || alias.internal) return false;
  const ip = alias.address;
  if (ip.startsWith('169.254.') || ip.startsWith('127.') || ip === '0.0.0.0') {
    return false;
  }
  return true;
}

const VIRTUAL_ADAPTER_NAME =
  /^(vethernet|wsl|docker|br-|veth|vmnet|vboxnet|vmware|virtualbox|hyper-v|tailscale|utun|tun|tap|zt|zerotier|ham|lo)/i;
const PHYSICAL_ADAPTER_NAME = /^(en\d|eth|wlan|wlp|enp|eno|ens|wi-?fi|ethernet|wireless)/i;

/** Scores an interface address for LAN pairing; higher is better, physical LAN adapters win over virtual or tunnel adapters. */
export function rankLocalIPv4(interfaceName: string, address: string): number {
  let score = 0;
  if (VIRTUAL_ADAPTER_NAME.test(interfaceName)) score -= 100;
  else if (PHYSICAL_ADAPTER_NAME.test(interfaceName)) score += 50;

  const octets = address.split('.').map(Number);
  const [a, b] = octets;
  if (a === 172 && b === 17) score -= 100;
  // VirtualBox host-only (192.168.56.x) and docker-machine (192.168.99.x) look like a home LAN but only reach VMs.
  else if (a === 192 && b === 168 && (octets[2] === 56 || octets[2] === 99)) score -= 100;
  else if (a === 192 && b === 168) score += 20;
  else if (a === 10) score += 15;
  else if (a === 172 && b >= 16 && b <= 31) score += 10;
  else if (a === 100 && b >= 64 && b <= 127) score -= 100;
  return score;
}

function listLocalIPv4(): string[] {
  const candidates: Array<{ address: string; score: number; order: number }> = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const alias of interfaces[name] ?? []) {
      if (isValidLocalIPv4(alias)) {
        candidates.push({
          address: alias.address,
          score: rankLocalIPv4(name, alias.address),
          order: candidates.length,
        });
      }
    }
  }
  const ranked = candidates.sort((x, y) => y.score - x.score || x.order - y.order);
  // WSL, Docker and VM host-only adapters only reach this computer, so phones are never sent there.
  // A VPN mesh address (100.64.0.0/10) stays, since devices on the mesh can reach it.
  const reachable = ranked.filter((c) => c.score >= 0 || isMeshAddress(c.address));
  return (reachable.length > 0 ? reachable : ranked).map((c) => c.address);
}

function isMeshAddress(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

/** Returns the best-ranked valid non-loopback IPv4 address on the machine. */
export function getLocalIP(): string {
  return listLocalIPv4()[0] ?? '127.0.0.1';
}

/** Returns all valid non-loopback IPv4 addresses on the machine, best-ranked first. */
export function getAllLocalIPs(): string[] {
  const ips = listLocalIPv4();
  return ips.length > 0 ? ips : ['127.0.0.1'];
}
