You are acting as a Principal Software Architect, Senior Full-Stack Engineer, Android Engineer and Technical Project Lead.

I have an existing project called Java QuickPick (V1). I want to preserve it exactly as it currently exists.

I now want to build an alternative product architecture with a different ordering workflow.

Your first and most important responsibility is to protect the existing V1 repository and build V2 independently.

1. CRITICAL REPOSITORY INSTRUCTIONS

The new project must be created in a separate repository named:

java-quickpick-v2

Non-negotiable rules

DO NOT modify the existing Java QuickPick repository.

DO NOT rename the existing repository.

DO NOT change the existing Git branches.

DO NOT modify existing source files, configurations, dependencies or database schemas.

DO NOT overwrite existing project files.

DO NOT implement V2 by adding branches or alternate features inside V1.

DO NOT delete or replace any existing functionality.

Required procedure

Step 1: Inspect the current working directory and identify the existing Java QuickPick repository.

Step 2: Check the existing repository's Git status to determine whether there are uncommitted changes.

Step 3: Inspect the existing architecture in READ-ONLY mode.

Step 4: Identify reusable technologies, design patterns and components that might be useful for V2.

Step 5: Create a completely separate sibling directory named:

java-quickpick-v2

Step 6: Initialise a new Git repository inside java-quickpick-v2.

Step 7: Create the V2 application independently.

If the new directory already exists, inspect it before making changes. Never overwrite existing V2 work.

Use separate environment variables, configurations, database names, deployment environments and Git history.

Do not copy:

.env files.

API keys or secrets.

Payment credentials.

Existing Git history.

node_modules.

Build artefacts.

Local database files.

You may selectively reuse existing application code or visual components by copying them into V2, provided this does not modify V1 and the code is suitable for the new architecture.

If the existing repository cannot be accessed safely, ask for the necessary directory access rather than guessing its location.

Do not push to GitHub or publish anything without my explicit authorisation.

At the beginning, clearly report:

Existing V1 repository location.

V1 Git status.

New V2 repository location.

Confirmation that V1 remains unchanged.

2. PROJECT IDENTITY

Project name: Java QuickPick V2

Repository: java-quickpick-v2

Location: Java Green Food Court, SRM Institute of Science and Technology, Kattankulathur, Tamil Nadu.

Business concept:

A multi-vendor food ordering and scheduled pickup platform.

The platform will connect independent food vendors at Java Green with students.

Participating vendors receive:

Android tablet.

Thermal kitchen printer.

Vendor order-management application.

Digital order notifications.

Menu management tools.

Students receive:

Mobile ordering application.

Two ordering modes.

Online payments.

Real-time order status.

Ready notifications.

Secure collection OTP.

3. CORE PRODUCT CONCEPT

The student application's homepage MUST prominently display two distinct options.

OPTION A: PRE-ORDER

This mode is intended for students who want to order before reaching Java Green.

Workflow:

Student opens Java QuickPick.

Selects PRE-ORDER.

Views all participating shops.

Selects a shop.

Browses the shop menu.

Adds items to the cart.

Selects an available pickup time.

Reviews the total price and convenience fee.

Pays online using the integrated payment provider.

Backend verifies the payment.

Order appears on the correct vendor tablet.

Vendor accepts or rejects the order.

On acceptance, a kitchen slip prints automatically.

Cook receives the printed slip.

Vendor prepares the food.

Vendor marks the order READY.

Student receives a push notification.

Student opens the application and presents their pickup OTP.

Vendor verifies the OTP.

Order is marked COLLECTED.

Pre-orders must support:

Pickup-slot selection.

Shop-specific preparation capacity.

Estimated preparation time.

Slot reservation.

Capacity validation.

Payment timeout.

Order cancellation and refund workflows.

OPTION B: WALK-IN

This mode is intended for students who are already physically present at Java Green.

It is NOT a traditional cashier POS.

The student must independently place the order through the shop-specific QR code.

Walk-in workflow

Student reaches Java Green.

Student scans the unique QR code displayed at a participating shop.

QR opens the shop-specific Java QuickPick ordering page.

The application automatically identifies the shop.

Student views that shop's menu.

Student selects food items.

Student adds items to cart.

Student sees the order subtotal, convenience fee and complete payable amount.

Student pays online.

Backend verifies the payment.

Order reaches the correct shop's vendor tablet.

Vendor accepts the order.

Kitchen slip automatically prints.

Shopkeeper hands the slip to the cook.

Cook prepares the order.

Shopkeeper marks the order READY.

Student receives a push notification.

Student opens Java QuickPick and presents the OTP.

Shopkeeper verifies the OTP on the vendor tablet.

The order is marked COLLECTED.

Critical requirements for WALK-IN

Every shop must have its own unique QR code.

The QR must identify the outlet automatically.

Students must not need to search for the shop manually.

Students should not need to install the application to use the QR ordering link.

Use universal links and a mobile-web fallback.

The shop menu must be loaded dynamically from the backend.

Students must not be able to access another shop's private vendor dashboard.

Walk-in orders should receive a realistic preparation estimate.

Walk-in orders should enter the shop's normal preparation queue.

4. IMPORTANT: WHAT V2 SHOULD NOT BUILD

Keep V2 focused on the two student-driven ordering modes.

Do NOT implement the earlier full vendor POS concept in V2.

Specifically, do not build:

Cashier-entered walk-in sales.

Forced digital billing of all existing physical shop sales.

A complete replacement for vendor billing systems.

Cash transaction management.

A vendor-controlled general-purpose POS.

In V2, every order originates from either:

Student PRE-ORDER.

Student WALK-IN QR.

The vendor tablet is used to manage these application orders, not to manually enter every customer's physical shop purchase.

Preserve this product distinction throughout development.

5. STUDENT APPLICATION REQUIREMENTS

Build a polished, production-oriented mobile-first PWA.

Homepage

Display:

Java QuickPick branding.

PRE-ORDER option.

WALK-IN explanation and QR entry functionality.

Participating outlets.

Active orders.

Order history.

Shop discovery

Display:

Shop logo or image.

Shop name.

Food categories.

Opening hours.

Availability.

Estimated preparation time.

Menu.

Menu

Support:

Food images.

Item descriptions.

Prices.

Categories.

Availability.

Vegetarian/non-vegetarian indicators where supplied by vendors.

Add-ons.

Customisation options.

Quantity selection.

Cart

Support:

Multiple items from one shop.

Item modifications.

Quantity changes.

Item removal.

Price breakdown.

Convenience fee.

Applicable tax treatment.

Final amount.

Do not initially support a cart containing items from multiple shops.

Checkout

PRE-ORDER:

Pickup slot.

Order summary.

Payment.

WALK-IN:

Automatically identified shop.

Immediate order submission.

Estimated preparation time.

Payment.

Order tracking

Display:

Order number.

Shop name.

Items.

Payment status.

Vendor acceptance.

Preparing status.

Ready status.

Collection OTP.

Collection confirmation.

Refund status, where applicable.

6. VENDOR AND KITCHEN APPLICATION

Build a tablet-optimised vendor Android application.

Technology preference:

React.

Capacitor.

Native Android printing integration.

Every participating shop gets its own vendor account and assigned devices.

Vendor dashboard

Display:

Incoming orders.

New orders.

Accepted orders.

Preparing orders.

Ready orders.

Completed orders.

Rejected orders.

Printer connection status.

Internet connection status.

Incoming order

When an order arrives:

Play an audible alert.

Display order number.

Display PRE-ORDER or WALK-IN source.

Display food items.

Display quantities and modifications.

Display pickup slot or estimated preparation time.

Display verified payment status.

Vendor actions

ACCEPT.

REJECT.

PREPARING.

READY.

COLLECTED.

Vendor actions must be authorised and recorded by the backend.

Vendor permissions

Each vendor must only be able to:

Access their own shop.

View their own incoming orders.

Manage their own menu.

Manage availability.

Update their own order statuses.

View their own settlements and reports.

Implement strict shop-level data access isolation.

7. THERMAL PRINTER INTEGRATION

Every participating shop is expected to receive an 80mm thermal printer.

Use ESC/POS-compatible hardware.

Before selecting a particular model, verify:

Android compatibility.

Bluetooth/Wi-Fi connectivity.

Supported SDK.

ESC/POS command support.

Printer reliability.

Availability in India.

Manufacturer support.

Do not assume ordinary React browser printing will work reliably for silent kitchen-ticket printing.

Use a Capacitor Android plugin or a tested native Android integration.

Automatic printing workflow

The printer should print only AFTER vendor acceptance.

Student payment is verified.

Order reaches vendor dashboard.

Vendor reviews order.

Vendor taps ACCEPT.

Backend commits acceptance.

Print job is created.

Native Android printing integration sends the kitchen ticket.

Print status is stored.

Vendor can retry failed jobs.

Kitchen ticket contents

Java QuickPick branding.

Shop name.

Unique order ID.

Order source.

Order time.

Pickup time or estimate.

Food item names.

Quantities.

Modifications.

Cooking instructions.

Clear preparation heading.

Never include:

Student passwords.

Payment credentials.

Student phone numbers.

Pickup OTP.

Printing reliability

Implement:

Persistent print-job storage.

Printer connection monitoring.

Automatic retry with controlled limits.

Manual reprinting.

Duplicate-print labels.

Printer error notifications.

Recovery after tablet restart.

A printer failure must never cause a paid order to be lost.

8. PICKUP OTP AND COLLECTION

Every paid and accepted order must have a secure collection mechanism.

Generate a random six-digit OTP.

Requirements:

Store a secure hash.

Link it to the specific order.

Reveal it to the student only when appropriate, preferably when the order becomes READY.

Do not put the OTP in the kitchen slip.

Do not show it to the vendor before student presentation.

Verify it on the server.

Limit unsuccessful attempts.

Expire it after a configured collection period.

Prevent reuse.

Log every successful and unsuccessful verification.

Provide an audited manual override for genuine exceptions.

After successful verification, mark the order COLLECTED and record the timestamp.

9. PAYMENT ARCHITECTURE

Evaluate Cashfree Easy Split as the initial payment provider.

The final provider must explicitly approve:

Online advance payments.

Walk-in QR-originated online payments.

Marketplace fee allocation.

Independent vendor onboarding.

Vendor settlement.

Refunds.

Do not assume online marketplace approval automatically authorises every proximity-payment arrangement.

Commercial model

The initial pricing hypothesis:

Original vendor food price.

7% customer-paid QuickPick convenience fee.

Vendor's agreed food-price entitlement.

QuickPick's separate fee collection.

Applicable taxes and payment charges separately accounted for.

Example:

Food subtotal: ₹100.

QuickPick fee: ₹7.

Student total before any separately applicable tax adjustment: ₹107.

The 7% rate must be configurable separately for PREORDER and WALKIN_QR.

Do not hard-code the fee.

Payment rules

Use hosted payment checkout.

Create payment sessions server-side.

Verify signed payment webhooks.

Verify amount, currency and order ID.

Use idempotency.

Prevent duplicate order creation.

Do not trust browser payment redirects.

Implement vendor allocation.

Implement refund handling.

Implement payment reconciliation.

Never store card credentials.

Never build an internal stored-value wallet.

Never collect vendor funds into personal accounts.

Tax treatment and settlement allocation must remain configurable pending professional confirmation.

Do not activate production payments until the payment provider, CA and applicable authorities approve the transaction structure.

10. NOTIFICATIONS

Use Firebase Cloud Messaging for push notifications.

Notifications required:

Order successfully placed.

Payment successful.

Vendor accepted.

Vendor rejected.

Order is being prepared, where useful.

Order ready.

Refund initiated.

Refund completed.

When vendor marks READY:

Backend changes order status.

Notification event is created.

Student receives a push alert.

App displays the collection OTP.

Order remains available on the tracking screen.

Implement notification retries and delivery-status records.

If push delivery fails, provide an in-app status fallback and an approved SMS fallback where appropriate and consented to.

11. TECHNICAL STACK

Use the following preferred architecture:

Student:

React.

Vite.

PWA.

Responsive mobile-first design.

Vendor:

React.

Capacitor.

Native Android printing integration.

Backend:

Node.js.

Express.

PostgreSQL.

Socket.IO.

Notifications:

Firebase Cloud Messaging.

Payments:

Approved Cashfree marketplace integration, subject to approval.

Admin:

React web dashboard.

Monitoring:

Sentry.

Structured backend logs.

Payment and print-job reconciliation.

Use a modular monolithic architecture initially. Do not introduce microservices or Kubernetes unnecessarily.

12. DATABASE REQUIREMENTS

Create and document the following entities:

users

shops

vendors

menu_categories

menu_items

menu_item_modifiers

orders

order_items

payments

payment_attempts

payment_splits

refunds

settlements

pickup_slots

vendor_devices

printer_devices

print_jobs

pickup_otps

notifications

webhook_events

order_events

complaints

reconciliation_records

Orders must support:

order_source:

PREORDER

WALKIN_QR

Prices must be snapshotted at checkout.

Payment status and order status must be separate.

Use proper relational integrity, transactions, indexes, audit history and unique constraints.

13. ADMIN DASHBOARD

Create an admin dashboard with:

Total shops.

Active shops.

Vendor onboarding.

Menu management.

QR generation.

Device management.

Printer health.

Incoming orders.

Order sources.

Payment totals.

Commission totals.

Refunds.

Vendor settlements.

Customer complaints.

Analytics by shop.

Analytics by ordering mode.

Peak ordering periods.

Do not expose one vendor's financial information to another vendor.

14. CRITICAL TEST SCENARIOS

Test the complete end-to-end process.

WALK-IN QR

Student scans Shop 01 QR.

Shop 01 menu opens.

Student adds food.

Student pays using sandbox payment.

Verified order reaches Shop 01.

Vendor accepts.

Slip prints.

Vendor marks READY.

Push notification arrives.

Student displays OTP.

Vendor verifies OTP.

Order becomes COLLECTED.

PRE-ORDER

Student selects PRE-ORDER.

Selects Shop 02.

Chooses menu.

Selects pickup slot.

Completes sandbox payment.

Vendor receives order.

Vendor accepts.

Slip prints.

Food is prepared.

Student receives ready notification.

Pickup OTP is verified.

Order becomes COLLECTED.

FAILURE TESTS

Test:

Invalid QR.

Suspended vendor.

Closed shop.

Unavailable item.

Full pickup capacity.

Failed payment.

Pending payment.

Duplicate payment webhook.

Payment success without browser return.

Vendor rejection.

Refund failure.

Printer disconnection.

Duplicate print.

Paper-out error if supported by the printer.

Push notification failure.

Invalid OTP.

Expired OTP.

OTP replay.

Student device disconnection.

Vendor tablet restart.

Simultaneous orders.

15. DEVELOPMENT PROCESS

Start by inspecting this new repository and producing:

Project architecture.

System requirements.

Database design.

API specifications.

UI route structure.

Printer integration approach.

Payment integration approach.

Implementation roadmap.

Test strategy.

Then start implementation.

Do not spend the entire first phase creating documents and attractive mockups. Build working functionality.

Your first end-to-end milestone is:

Walk-in QR → Menu → Cart → Sandbox Payment → Vendor Tablet → Accept → Kitchen Printer → Ready Notification → OTP → Collection.

Then implement PREORDER.

Build a reliable vertical slice before adding advanced features.

16. QUALITY AND SECURITY EXPECTATIONS

Follow clean code conventions.

Use TypeScript where practical.

Separate frontend and backend responsibilities.

Validate every API input.

Implement role-based authentication.

Protect shop-level resources.

Secure payment webhooks.

Store secrets in environment variables.

Never commit credentials.

Use database migrations.

Write automated tests.

Implement error handling.

Maintain structured logs.

Document all environment setup.

Do not fabricate successful integration tests.

Do not enable real payment processing prematurely.

At the end of each implementation milestone, report:

Files created.

Files modified.

Features implemented.

Tests executed.

Verified test results.

Remaining defects.

Next implementation milestone.

FINAL INSTRUCTION

Implement Java QuickPick V2 independently.

Preserve Java QuickPick V1 completely.

The new repository is:

java-quickpick-v2

Do not make any changes to the original V1 repository.

Begin with repository inspection, independent setup and the implementation plan. Then build the first functional WALKIN_QR vertical slice.