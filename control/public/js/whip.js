/**
 * Minimal WHIP (WebRTC-HTTP Ingestion Protocol) publisher client, written
 * directly against MediaMTX's documented WHIP endpoint
 * (POST SDP offer -> 201 Created with SDP answer + Location header for
 * teardown). This lets "Go live from browser" work with no OBS and no
 * extra backend service - MediaMTX IS the WHIP server.
 */
class WhipPublisher {
  constructor(whipUrl) {
    this.whipUrl = whipUrl;
    this.pc = null;
    this.resourceUrl = null;
  }

  async publish(stream) {
    this.pc = new RTCPeerConnection();
    for (const track of stream.getTracks()) {
      this.pc.addTrack(track, stream);
    }

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    const res = await fetch(this.whipUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: offer.sdp,
    });

    if (!res.ok) {
      throw new Error(`WHIP publish failed: ${res.status}`);
    }

    const answerSdp = await res.text();
    const location = res.headers.get('Location');
    this.resourceUrl = location
      ? new URL(location, this.whipUrl).toString()
      : null;

    await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    return this.pc;
  }

  async stop() {
    if (this.resourceUrl) {
      try {
        await fetch(this.resourceUrl, { method: 'DELETE' });
      } catch {
        // best-effort teardown; ignore network errors on stop
      }
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WhipPublisher };
}
