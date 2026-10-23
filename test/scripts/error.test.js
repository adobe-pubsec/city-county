import { expect } from '@esm-bundle/chai';
import sinon from 'sinon';
import error from '../../scripts/utils/error.js';
import { getConfig, loadExperience, setConfig } from '../../scripts/ak.js';

describe('error handling', () => {
  let log;
  let section;
  let config;

  beforeEach(() => {
    config = getConfig();
    log = sinon.stub(console, 'log');
    section = document.createElement('section');
    section.innerHTML = '<div class="missing-block-regression"><div><div>Authored content</div></div></div>';
    document.body.append(section);
  });

  afterEach(() => {
    log.restore();
    section.remove();
    setConfig(config);
  });

  it('logs errors without wrapping or changing authored content', async () => {
    const block = section.firstElementChild;
    const html = section.innerHTML;
    const ex = new Error('Block failed');
    await error(ex, block);
    expect(log.calledOnceWithExactly(ex)).to.be.true;
    expect(block.parentElement).to.equal(section);
    expect(section.innerHTML).to.equal(html);
    expect(document.querySelector('link[href$="/styles/error.css"]')).to.be.null;
  });

  it('logs errors without an associated element', async () => {
    const ex = new Error('No element');
    await error(ex);
    expect(log.calledOnceWithExactly(ex)).to.be.true;
  });

  it('leaves missing blocks in place and resolves loading', async () => {
    const block = section.firstElementChild;
    const html = section.innerHTML;
    setConfig({ ...config, log: undefined });
    const result = await loadExperience(block, 'blocks', 'missing-block-regression', {
      decorate: true,
      style: false,
    });
    expect(result).to.equal(block);
    expect(log.calledOnce).to.be.true;
    expect(section.innerHTML).to.equal(html);
    expect(document.querySelector('link[href$="/styles/error.css"]')).to.be.null;
  });

  it('preserves custom error logging', async () => {
    const customLog = sinon.stub();
    setConfig({ ...config, log: customLog });
    const block = section.firstElementChild;
    await loadExperience(block, 'blocks', 'missing-block-regression', {
      decorate: true,
      style: false,
    });
    expect(customLog.calledOnce).to.be.true;
    expect(customLog.firstCall.args[1]).to.equal(block);
    expect(log.called).to.be.false;
  });
});
