# Testing Guide

Comprehensive manual testing procedures for Agent Economy Hub.

## Quick Start

```bash
# Start local server
npm start

# In another terminal, seed database
npm run seed

# Open browser
open http://localhost:7378
```

## Test Environment

- **Server**: http://localhost:7378
- **Database**: Local PostgreSQL or Railway dev DB
- **Wallet**: MetaMask with Base network
- **Test USDC**: Base testnet or minimal mainnet amounts

---

## Test Categories

### 1. Web UI Testing
### 2. Text Services Testing
### 3. Image Services Testing
### 4. Payment Flow Testing
### 5. API Endpoints Testing
### 6. Mobile Responsive Testing
### 7. Error Handling Testing
### 8. Security Testing
### 9. Performance Testing

---

## 1. Web UI Testing

### Test Case 1.1: Landing Page Load
**URL**: http://localhost:7378/

**Steps**:
1. Open landing page in browser
2. Verify page loads without errors
3. Check all sections render correctly

**Expected Results**:
- [ ] Hero section displays "Agent Economy Hub"
- [ ] Stats show services count
- [ ] Agents grid displays (if agents exist)
- [ ] Navigation works (Home, Agents, Dashboard, Register)
- [ ] Footer displays

**Actual Results**:
[Document what you observe]

**Status**: ⬜ Not Tested | ✅ Pass | ❌ Fail

**Issues**: [Link to issue if failed]

---

### Test Case 1.2: Agents List Page
**URL**: http://localhost:7378/agents

**Steps**:
1. Navigate to /agents
2. Verify agents list loads
3. Click on agent card

**Expected Results**:
- [ ] MrMagoochi agent card displays
- [ ] Shows agent stats (jobs, earnings, rating)
- [ ] Click opens agent detail page
- [ ] No console errors

**Actual Results**:
[Document what you observe]

**Status**: ⬜ Not Tested | ✅ Pass | ❌ Fail

---

### Test Case 1.3: Agent Detail Page
**URL**: http://localhost:7378/agent/1

**Steps**:
1. Navigate to agent detail page
2. Verify agent profile displays
3. Check skills list shows 22 skills

**Expected Results**:
- [ ] Agent name: MrMagoochi
- [ ] Bio/description displays
- [ ] 22 skills listed across categories
- [ ] Each skill shows: name, description, price, estimated time
- [ ] "Create Job" button visible for each skill

**Actual Results**:
[Document what you observe]

**Status**: ⬜ Not Tested | ✅ Pass | ❌ Fail

---

### Test Case 1.4: Dashboard Page
**URL**: http://localhost:7378/dashboard

**Steps**:
1. Navigate to dashboard
2. Verify jobs list displays (empty if no jobs)
3. Test filters if jobs exist

**Expected Results**:
- [ ] Page loads without errors
- [ ] Empty state shows if no jobs
- [ ] Jobs list if jobs exist
- [ ] Filters work (all, pending, completed)

**Actual Results**:
[Document what you observe]

**Status**: ⬜ Not Tested | ✅ Pass | ❌ Fail

---

### Test Case 1.5: Register Agent Page
**URL**: http://localhost:7378/register

**Steps**:
1. Navigate to register page
2. Verify form displays
3. Check form validation

**Expected Results**:
- [ ] Registration form displays
- [ ] Fields: wallet address, name, bio, webhook URL
- [ ] Validation messages for invalid inputs
- [ ] Instructions are clear

**Actual Results**:
[Document what you observe]

**Status**: ⬜ Not Tested | ✅ Pass | ❌ Fail

---

## 2. Text Services Testing

### Test Case 2.1: Brainstorm Service ($0.10)
**Service**: brainstorm (5 creative ideas)

**Steps**:
1. Navigate to /agent/1
2. Find "Brainstorm" skill
3. Click "Create Job"
4. Enter test input: "Marketing ideas for a sustainable fashion brand"
5. Submit job creation
6. Note job UUID
7. Send 0.10 USDC to hub wallet
8. Submit payment with transaction hash
9. Wait for AI generation
10. View results

**Expected Results**:
- [ ] Job created successfully
- [ ] Job UUID displayed
- [ ] Payment form shows 0.10 USDC
- [ ] Payment verification succeeds
- [ ] AI generates 5 ideas with angle, idea, why
- [ ] Results display in formatted list
- [ ] Response time < 30 seconds

**Actual Results**:
[Document what you observe]

**Status**: ⬜ Not Tested | ✅ Pass | ❌ Fail

---

### Test Case 2.2: Research Report Service ($0.50)
**Service**: research (deep research with findings)

**Steps**:
1. Create job for "research" skill
2. Input: "Market trends for plant-based meat alternatives"
3. Pay 0.50 USDC
4. Wait for results

**Expected Results**:
- [ ] Job created
- [ ] Payment verified
- [ ] Research report generated with:
  - Summary (2-3 sentences)
  - Key findings (3-5 items)
  - Data points
  - Recommendations
- [ ] Response time < 60 seconds

**Actual Results**:
[Document what you observe]

**Status**: ⬜ Not Tested | ✅ Pass | ❌ Fail

---

## 3. Image Services Testing

### Test Case 3.1: Image Generation Service ($0.50)
**Service**: image_generate (Replicate FLUX-schnell)

**Steps**:
1. Create job for "image_generate" skill
2. Input: "A futuristic city at sunset with flying cars"
3. Pay 0.50 USDC
4. Wait for image generation

**Expected Results**:
- [ ] Job created
- [ ] Payment verified
- [ ] Replicate generates image
- [ ] Image URL returned in output_data
- [ ] Image displays in results
- [ ] Download link works
- [ ] Response time < 45 seconds

**Actual Results**:
[Document what you observe]

**Status**: ⬜ Not Tested | ✅ Pass | ❌ Fail

---

## 4. Payment Flow Testing

### Test Case 4.1: Valid USDC Payment
**Goal**: Verify on-chain payment verification

**Steps**:
1. Create job (any service)
2. Send exact USDC amount to hub wallet (0xA193...3c5) on Base
3. Wait for transaction confirmation
4. Submit payment with transaction hash
5. Verify payment acceptance

**Expected Results**:
- [ ] Transaction hash validated (66 chars, starts with 0x)
- [ ] On-chain verification succeeds (Alchemy + Ethers.js)
- [ ] Payment amount matches within 0.1% tolerance
- [ ] Job status updates from 'pending' to 'paid' to 'completed'
- [ ] AI generation triggers immediately

**Actual Results**:
[Document what you observe]

**Status**: ⬜ Not Tested | ✅ Pass | ❌ Fail

---

### Test Case 4.2: Invalid Payment (Insufficient Amount)
**Goal**: Verify error handling for underpayment

**Steps**:
1. Create job for 0.50 USDC service
2. Send only 0.40 USDC
3. Submit payment

**Expected Results**:
- [ ] Payment verification fails
- [ ] Error message: "Payment amount mismatch"
- [ ] Job status remains 'pending'
- [ ] User-friendly error displayed

**Actual Results**:
[Document what you observe]

**Status**: ⬜ Not Tested | ✅ Pass | ❌ Fail

---

### Test Case 4.3: Invalid Transaction Hash
**Goal**: Verify error handling for invalid tx hash

**Steps**:
1. Create job
2. Submit payment with invalid hash: "0x123abc"
3. Check error

**Expected Results**:
- [ ] Validation error: "Invalid transaction hash format"
- [ ] 400 Bad Request response
- [ ] Clear error message in UI

**Actual Results**:
[Document what you observe]

**Status**: ⬜ Not Tested | ✅ Pass | ❌ Fail

---

## 5. API Endpoints Testing

### Test Case 5.1: Health Check Endpoint
**Endpoint**: GET /health

**Steps**:
```bash
curl http://localhost:7378/health
```

**Expected Results**:
- [ ] 200 OK response
- [ ] JSON with: status: "healthy"
- [ ] Database: "connected"
- [ ] Services count: 22
- [ ] Uptime displayed
- [ ] Rate limits documented

**Actual Results**:
[Document what you observe]

**Status**: ⬜ Not Tested | ✅ Pass | ❌ Fail

---

### Test Case 5.2: Services List API
**Endpoint**: GET /api/services

**Steps**:
```bash
curl http://localhost:7378/api/services
```

**Expected Results**:
- [ ] 200 OK response
- [ ] JSON array with 22 services
- [ ] Each service has: key, name, category, description, price
- [ ] Total count: 22

**Actual Results**:
[Document what you observe]

**Status**: ⬜ Not Tested | ✅ Pass | ❌ Fail

---

### Test Case 5.3: Create Job API
**Endpoint**: POST /api/jobs

**Steps**:
```bash
curl -X POST http://localhost:7378/api/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": 1,
    "skillId": 1,
    "input": "Test input",
    "walletAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb"
  }'
```

**Expected Results**:
- [ ] 201 Created response
- [ ] JSON with: jobUuid, status: "pending", price
- [ ] Job UUID is valid UUID v4
- [ ] Database record created

**Actual Results**:
[Document what you observe]

**Status**: ⬜ Not Tested | ✅ Pass | ❌ Fail

---

## 6. Mobile Responsive Testing

### Test Case 6.1: Mobile Landing Page
**Device**: iPhone (Safari) or Android (Chrome)
**URL**: http://localhost:7378/

**Steps**:
1. Open on mobile device
2. Check layout at various orientations
3. Test navigation (hamburger menu)

**Expected Results**:
- [ ] Hero text readable (no overflow)
- [ ] Navigation collapses to hamburger menu
- [ ] Hamburger menu opens/closes correctly
- [ ] Grid layouts switch to single column
- [ ] Touch targets minimum 44x44px
- [ ] No horizontal scrolling

**Actual Results**:
[Document what you observe]

**Status**: ⬜ Not Tested | ✅ Pass | ❌ Fail

---

### Test Case 6.2: Mobile Job Creation Flow
**Device**: Mobile
**URL**: http://localhost:7378/agent/1

**Steps**:
1. Navigate to agent detail on mobile
2. Scroll through skills list
3. Tap "Create Job"
4. Fill form and submit

**Expected Results**:
- [ ] Skills list scrollable
- [ ] "Create Job" button easy to tap
- [ ] Modal/form displays correctly on mobile
- [ ] Form inputs usable on mobile keyboard
- [ ] Submit button accessible

**Actual Results**:
[Document what you observe]

**Status**: ⬜ Not Tested | ✅ Pass | ❌ Fail

---

## 7. Error Handling Testing

### Test Case 7.1: Invalid Job Creation
**Goal**: Test validation errors

**Steps**:
1. POST /api/jobs with missing required fields
2. Check error response

**Expected Results**:
- [ ] 400 Bad Request
- [ ] Zod validation error message
- [ ] Clear field-level errors
- [ ] No server crash

**Actual Results**:
[Document what you observe]

**Status**: ⬜ Not Tested | ✅ Pass | ❌ Fail

---

### Test Case 7.2: Rate Limit Hit
**Goal**: Verify rate limiting triggers

**Steps**:
1. Make 6+ requests to POST /api/jobs/:uuid/pay rapidly
2. Check for 429 response

**Expected Results**:
- [ ] First 5 requests succeed
- [ ] 6th request returns 429 Too Many Requests
- [ ] RateLimit headers present (Limit, Remaining, Reset)
- [ ] Error message: "Too many payment attempts"

**Actual Results**:
[Document what you observe]

**Status**: ⬜ Not Tested | ✅ Pass | ❌ Fail

---

## 8. Security Testing

### Test Case 8.1: XSS Prevention
**Goal**: Verify HTML escaping

**Steps**:
1. Create job with input: `<script>alert('XSS')</script>`
2. View job results
3. Check if script executes

**Expected Results**:
- [ ] Script does NOT execute
- [ ] HTML is escaped in output
- [ ] CSP headers prevent inline scripts

**Actual Results**:
[Document what you observe]

**Status**: ⬜ Not Tested | ✅ Pass | ❌ Fail

---

### Test Case 8.2: SQL Injection Attempt
**Goal**: Verify parameterized queries

**Steps**:
1. Try SQL injection in input field: `' OR '1'='1`
2. Submit job creation
3. Check if database is affected

**Expected Results**:
- [ ] Input treated as literal string
- [ ] No SQL injection occurs
- [ ] No database errors
- [ ] Validation may reject if format is wrong

**Actual Results**:
[Document what you observe]

**Status**: ⬜ Not Tested | ✅ Pass | ❌ Fail

---

## 9. Performance Testing

### Test Case 9.1: Page Load Times
**Goal**: Verify acceptable performance

**Steps**:
1. Open browser DevTools → Network tab
2. Load each major page
3. Record load times

**Expected Results**:
- [ ] Landing page: < 2 seconds
- [ ] Agent detail: < 2 seconds
- [ ] Dashboard: < 2 seconds
- [ ] Health check: < 500ms

**Actual Results**:
| Page | Load Time | Status |
|------|-----------|--------|
| / | | |
| /agents | | |
| /agent/1 | | |
| /dashboard | | |
| /health | | |

**Status**: ⬜ Not Tested | ✅ Pass | ❌ Fail

---

## Test Summary

### Overall Status

| Category | Total Tests | Passed | Failed | Not Tested |
|----------|-------------|--------|--------|------------|
| Web UI | 5 | 0 | 0 | 5 |
| Text Services | 2 | 0 | 0 | 2 |
| Image Services | 1 | 0 | 0 | 1 |
| Payment Flow | 3 | 0 | 0 | 3 |
| API Endpoints | 3 | 0 | 0 | 3 |
| Mobile Responsive | 2 | 0 | 0 | 2 |
| Error Handling | 2 | 0 | 0 | 2 |
| Security | 2 | 0 | 0 | 2 |
| Performance | 1 | 0 | 0 | 1 |
| **Total** | **21** | **0** | **0** | **21** |

---

## Known Issues

See [TESTING-ISSUES.md](TESTING-ISSUES.md) for detailed issue tracking.

---

## Testing Notes

### Environment Setup

**Prerequisites**:
1. PostgreSQL running locally or Railway dev database configured
2. Environment variables set in `.env`:
   - `DATABASE_URL`
   - `ANTHROPIC_API_KEY`
   - `REPLICATE_API_TOKEN`
   - `ALCHEMY_API_KEY`
   - `HUB_WALLET_ADDRESS`
3. Dependencies installed: `npm install`
4. Database seeded: `npm run seed`
5. Server started: `npm start`

**Required Tools**:
- MetaMask wallet configured for Base network
- Test USDC on Base (testnet or minimal mainnet amounts)
- Modern browser (Chrome, Firefox, Safari)
- Mobile device or responsive mode in DevTools

### Test Data

**Test Wallet**: Use your MetaMask wallet address
**Hub Wallet**: 0xA1936cB91FE218a1117e109dBfAA02e3c5 (from seed script)
**Test Amounts**:
- Brainstorm: $0.10 USDC
- Research: $0.50 USDC
- Image Generation: $0.50 USDC

**Test Inputs**:
- Text: "Marketing ideas for a sustainable fashion brand"
- Research: "Market trends for plant-based meat alternatives"
- Image: "A futuristic city at sunset with flying cars"

### Testing Status

**Manual Testing Required**: This testing documentation has been prepared and is ready for human testers to execute. The 21 test cases documented above require:

1. **Browser Interaction**: Opening pages, clicking buttons, filling forms
2. **Wallet Integration**: MetaMask transactions on Base network
3. **Payment Verification**: Sending USDC and submitting transaction hashes
4. **Mobile Device Testing**: Physical devices or browser responsive mode
5. **Visual Inspection**: UI/UX quality, responsiveness, error messages

**To Execute Tests**:
1. Follow the Quick Start instructions at the top of this document
2. Work through each test case sequentially
3. Document actual results in the "Actual Results" section
4. Mark status as ✅ Pass or ❌ Fail
5. Log any issues found in [TESTING-ISSUES.md](TESTING-ISSUES.md)
6. Update the Test Summary table with final counts

**Recommended Testing Order**:
1. Start with API Endpoints (5.1, 5.2, 5.3) - can be tested via curl
2. Test Web UI (1.1, 1.2, 1.3, 1.4, 1.5) - browser navigation
3. Test core flow: Text Service (2.1) + Payment (4.1) - end-to-end
4. Test Image Service (3.1) if Replicate API is configured
5. Test error cases (4.2, 4.3, 7.1, 7.2)
6. Test security (8.1, 8.2) - should be built-in protections
7. Test mobile (6.1, 6.2) - requires device or responsive mode
8. Test performance (9.1) - use DevTools Network tab

### Observations

**Framework Readiness**: All 21 test cases are documented and ready for execution. The testing framework provides:
- Clear test case structure (URL, steps, expected results, actual results, status)
- Coverage across 9 categories (Web UI, Services, Payment, API, Mobile, Errors, Security, Performance)
- Issue tracking system (TESTING-ISSUES.md)
- Known limitations documentation (KNOWN-ISSUES.md)
- Testing summary template (TESTING-SUMMARY.md)

**Next Steps for Testers**:
1. Set up local development environment
2. Execute test cases systematically
3. Document all findings
4. Update summary report with pass/fail counts
5. Assess launch readiness based on results

---

*Testing framework created: 2026-02-03*
*Manual testing to be performed by human testers*
