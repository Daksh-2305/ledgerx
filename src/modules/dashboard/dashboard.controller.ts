import { Request, Response, NextFunction } from 'express';
import { getPrismaClient, checkDatabaseHealth } from '../../db/client.js';
import { formatMinorToMajor } from '../../common/money.js';

export class DashboardController {
  public static getMetrics = async (
    _req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const dbHealth = await checkDatabaseHealth();

      if (!dbHealth.connected) {
        // Dynamic aggregation for in-memory / offline mode
        const { getPaymentContainer } = await import('../payments/payment.container.js');
        const { getReconciliationContainer } = await import('../reconciliation/reconciliation.container.js');
        const { getSettlementContainer } = await import('../settlements/settlement.container.js');

        const [payCont, reconCont, settleCont] = await Promise.all([
          getPaymentContainer().catch(() => null),
          getReconciliationContainer().catch(() => null),
          getSettlementContainer().catch(() => null),
        ]);

        const payments = payCont ? (await payCont.repository.findPayments({ page: 1, limit: 5000 })).payments : [];

        let totalPaymentVolumeMinor = 0;
        let successfulPayments = 0;
        let failedPayments = 0;
        let pendingPayments = 0;
        let refundVolumeMinor = 0;
        const statusDistribution: Record<string, number> = {};
        const volumeTrend: { amount: number; timestamp: string }[] = [];

        for (const p of payments) {
          const amt = Number(p.amountMinor || 0);
          totalPaymentVolumeMinor += amt;
          refundVolumeMinor += Number(p.refundedAmountMinor || 0);

          statusDistribution[p.status] = (statusDistribution[p.status] || 0) + 1;

          if (['CAPTURED', 'SETTLED', 'PARTIALLY_REFUNDED'].includes(p.status)) {
            successfulPayments++;
            volumeTrend.push({
              amount: amt,
              timestamp: p.createdAt instanceof Date ? p.createdAt.toISOString() : String(p.createdAt),
            });
          } else if (['FAILED', 'CANCELLED'].includes(p.status)) {
            failedPayments++;
          } else if (['PENDING', 'CREATED', 'AUTHORIZED'].includes(p.status)) {
            pendingPayments++;
          }
        }

        let openReconciliationIssues = 0;
        if (reconCont) {
          try {
            const reconMetrics = await reconCont.service.getDashboardMetrics();
            openReconciliationIssues = reconMetrics.openDiscrepancies ?? 0;
          } catch {}
        }

        let settlementAmountMinor = 0;
        if (settleCont) {
          try {
            const batches = await settleCont.service.listBatches({ limit: 100 });
            for (const b of batches.batches) {
              if (b.status === 'SETTLED') {
                settlementAmountMinor += Number(b.netAmountMinor || 0);
              }
            }
          } catch {}
        }

        res.status(200).json({
          data: {
            totalPaymentVolumeMinor,
            totalPaymentVolumeFormatted: formatMinorToMajor(BigInt(totalPaymentVolumeMinor), 'INR') + ' INR',
            successfulPayments,
            failedPayments,
            pendingPayments,
            refundVolumeMinor,
            refundVolumeFormatted: formatMinorToMajor(BigInt(refundVolumeMinor), 'INR') + ' INR',
            openReconciliationIssues,
            settlementAmountMinor,
            settlementAmountFormatted: formatMinorToMajor(BigInt(settlementAmountMinor), 'INR') + ' INR',
            webhookFailures: 0,
            highRiskPayments: 0,
            totalPayments: payments.length,
            statusDistribution,
            volumeTrend: volumeTrend.slice(-15),
          },
        });
        return;
      }

      const prisma = getPrismaClient();

      const [
        paymentAggregates,
        statusGroups,
        openReconCount,
        settlementAggregates,
        webhookFailuresCount,
        highRiskCount,
        recentPayments,
      ] = await Promise.all([
        prisma.payment.aggregate({
          _sum: {
            amountMinor: true,
            refundedAmountMinor: true,
          },
          _count: {
            id: true,
          },
        }),
        prisma.payment.groupBy({
          by: ['status'],
          _count: {
            id: true,
          },
        }),
        prisma.reconciliationRecord.count({
          where: {
            status: { in: ['OPEN', 'INVESTIGATING'] },
            result: { not: 'MATCHED' },
          },
        }),
        prisma.settlementBatch.aggregate({
          where: {
            status: 'SETTLED',
          },
          _sum: {
            netAmountMinor: true,
          },
        }),
        prisma.webhookEvent.count({
          where: {
            status: { in: ['FAILED', 'DEAD_LETTERED'] },
          },
        }),
        prisma.riskAssessment.count({
          where: {
            riskLevel: { in: ['HIGH', 'CRITICAL'] },
          },
        }),
        prisma.payment.findMany({
          take: 50,
          orderBy: { createdAt: 'desc' },
          select: {
            amountMinor: true,
            status: true,
            createdAt: true,
          },
        }),
      ]);

      const totalVolumeMinor = paymentAggregates._sum.amountMinor
        ? Number(paymentAggregates._sum.amountMinor)
        : 0;
      const refundVolumeMinor = paymentAggregates._sum.refundedAmountMinor
        ? Number(paymentAggregates._sum.refundedAmountMinor)
        : 0;
      const settlementAmountMinor = settlementAggregates._sum.netAmountMinor
        ? Number(settlementAggregates._sum.netAmountMinor)
        : 0;

      const statusMap: Record<string, number> = {};
      let successfulCount = 0;
      let failedCount = 0;
      let pendingCount = 0;

      for (const group of statusGroups) {
        statusMap[group.status] = group._count.id;
        if (['CAPTURED', 'SETTLED', 'PARTIALLY_REFUNDED'].includes(group.status)) {
          successfulCount += group._count.id;
        } else if (['FAILED', 'CANCELLED'].includes(group.status)) {
          failedCount += group._count.id;
        } else if (['PENDING', 'CREATED', 'REFUND_PENDING'].includes(group.status)) {
          pendingCount += group._count.id;
        }
      }

      res.status(200).json({
        data: {
          totalPaymentVolumeMinor: totalVolumeMinor,
          totalPaymentVolumeFormatted: formatMinorToMajor(totalVolumeMinor, 'INR'),
          successfulPayments: successfulCount,
          failedPayments: failedCount,
          pendingPayments: pendingCount,
          refundVolumeMinor: refundVolumeMinor,
          refundVolumeFormatted: formatMinorToMajor(refundVolumeMinor, 'INR'),
          openReconciliationIssues: openReconCount,
          settlementAmountMinor: settlementAmountMinor,
          settlementAmountFormatted: formatMinorToMajor(settlementAmountMinor, 'INR'),
          webhookFailures: webhookFailuresCount,
          highRiskPayments: highRiskCount,
          totalPayments: paymentAggregates._count.id,
          statusDistribution: statusMap,
          volumeTrend: recentPayments.map((p) => ({
            amount: Number(p.amountMinor),
            status: p.status,
            createdAt: p.createdAt.toISOString(),
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  };
}
